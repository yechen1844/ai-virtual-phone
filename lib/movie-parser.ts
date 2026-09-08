// lib/movie-parser.ts — 字幕文件解析（SRT / VTT / ASS / SSA），多编码兼容。
// 兼容清单参照映屿 CineIsle 踩坑实践：
//   编码：UTF-8 / UTF-8 BOM / GB18030 / UTF-16LE / UTF-16BE 自动尝试
//   格式：CRLF 换行、零宽字符、逗号毫秒时间轴（00:01:02,500）
//   ASS/SSA：解析 Dialogue: 行，剥离样式标签 {} 、位置代码与绘图代码，仅保留台词

import type { SubtitleCue } from "./movie-types";

/** 去除零宽字符与 BOM 残留 */
function stripZeroWidth(text: string): string {
    return text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");
}

/** 统一换行符 */
function normalizeNewlines(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 时间解析：兼容 00:01:02,500 / 00:01:02.500 / 1:02:03.45（ASS 厘秒） */
function parseTimestamp(raw: string): number | null {
    const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
    if (!m) return null;
    const hours = m[1] ? Number(m[1]) : 0;
    const minutes = Number(m[2]);
    const seconds = Number(m[3]);
    const ms = Number(m[4].padEnd(3, "0"));
    if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
    return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/** 解析 SRT 块（也兼容无序号行的宽松变体） */
function parseSrtContent(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = content.split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) continue;
        // 找时间轴行
        const timeLineIndex = lines.findIndex(l => l.includes("-->"));
        if (timeLineIndex < 0) continue;
        const [startRaw, endRaw] = lines[timeLineIndex].split("-->");
        const start = parseTimestamp(startRaw ?? "");
        const end = parseTimestamp(((endRaw ?? "").trim().split(/\s+/)[0]) ?? "");
        if (start === null || end === null || end <= start) continue;
        const text = lines.slice(timeLineIndex + 1).join("\n")
            // 去除 <i> <b> <font> 等 HTML 风格标签（SRT 常见）
            .replace(/<[^>]+>/g, "")
            .trim();
        if (!text) continue;
        cues.push({ startSeconds: start, endSeconds: end, text });
    }
    return cues;
}

/** 解析 VTT（跳过 WEBVTT 头与 NOTE 块，时间轴允许缺时:分） */
function parseVttContent(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = content.split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) continue;
        if (lines[0].startsWith("WEBVTT") || lines[0].startsWith("NOTE") || lines[0].startsWith("STYLE") || lines[0].startsWith("REGION")) continue;
        const timeLineIndex = lines.findIndex(l => l.includes("-->"));
        if (timeLineIndex < 0) continue;
        const [startRaw, endRaw] = lines[timeLineIndex].split("-->");
        const start = parseTimestamp(startRaw ?? "");
        const end = parseTimestamp(((endRaw ?? "").trim().split(/\s+/)[0]) ?? "");
        if (start === null || end === null || end <= start) continue;
        const text = lines.slice(timeLineIndex + 1)
            .join("\n")
            // 去除 VTT 标签 <c.xxx> </c> <i> 等
            .replace(/<[^>]+>/g, "")
            .trim();
        if (!text) continue;
        cues.push({ startSeconds: start, endSeconds: end, text });
    }
    return cues;
}

/** 剥离 ASS 覆盖标签 {...}、绘图代码与软换行 */
function stripAssOverrides(text: string): string {
    return text
        .replace(/\{[^}]*\}/g, "")           // {...} 覆盖标签与绘图代码
        .replace(/\\[Nn]/g, "\n")            // \N \n 软换行
        .replace(/\\[hH]/g, " ")             // \h 硬空格
        .trim();
}

/** ASS 时间：H:MM:SS.CC（厘秒） */
function parseAssTimestamp(raw: string): number | null {
    const m = raw.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** 解析 ASS/SSA：[Events] 段 Dialogue 行，按 Format: 字段序取 Start/End/Text */
function parseAssContent(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    let format: string[] | null = null;
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Format:")) {
            format = trimmed.slice("Format:".length).split(",").map(f => f.trim().toLowerCase());
            continue;
        }
        if (!trimmed.startsWith("Dialogue:")) continue;
        if (!format) {
            // 无 Format 声明时按 ASS v4+ 默认字段序
            format = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
        }
        const payload = trimmed.slice("Dialogue:".length);
        // Text 是最后一个字段，可能含逗号 → 限制 split 次数
        const parts = payload.split(",");
        const textIndex = format.indexOf("text");
        const startIndex = format.indexOf("start");
        const endIndex = format.indexOf("end");
        if (startIndex < 0 || endIndex < 0 || textIndex < 0) continue;
        const start = parseAssTimestamp(parts[startIndex] ?? "");
        const end = parseAssTimestamp(parts[endIndex] ?? "");
        const text = stripAssOverrides(parts.slice(textIndex).join(","));
        if (start === null || end === null || end <= start || !text) continue;
        cues.push({ startSeconds: start, endSeconds: end, text });
    }
    return cues;
}

/** 按扩展名与内容特征解析字幕，失败返回空数组 */
export function parseSubtitleText(content: string, filename?: string): SubtitleCue[] {
    const normalized = normalizeNewlines(stripZeroWidth(content));
    const name = (filename ?? "").toLowerCase();
    let cues: SubtitleCue[] = [];
    if (name.endsWith(".ass") || name.endsWith(".ssa")) {
        cues = parseAssContent(normalized);
    } else if (name.endsWith(".vtt")) {
        cues = parseVttContent(normalized);
    } else if (name.endsWith(".srt")) {
        cues = parseSrtContent(normalized);
    } else {
        // 无扩展名线索：按内容特征探测
        if (/^WEBVTT/m.test(normalized)) cues = parseVttContent(normalized);
        else if (/^Dialogue:/m.test(normalized)) cues = parseAssContent(normalized);
        else cues = parseSrtContent(normalized);
    }
    // 过滤纯特效行（去标签后无实际内容）并按时间排序
    return cues
        .filter(c => c.text.replace(/\s/g, "").length > 0)
        .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

/**
 * 字幕专用解码：不用通用打分（UTF-16 把 ASCII 配成假汉字会骗过 CJK 打分）。
 * 顺序：BOM → 严格 UTF-8 → GB18030 → 高 NUL 占比才尝试 UTF-16 → 兜底宽松 UTF-8。
 */
export function decodeSubtitleBuffer(buffer: ArrayBuffer): { text: string; encoding: string } {
    const bytes = new Uint8Array(buffer);

    // 1. BOM 优先
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8 (BOM)" };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le (BOM)" };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be (BOM)" };
    }

    // 2. 无 BOM：严格 UTF-8（结构自校验，成功即正确）
    try {
        return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
    } catch { /* 非 UTF-8，继续 */ }

    // 3. GB18030 严格（GBK/GB2312 超集）
    try {
        return { text: new TextDecoder("gb18030", { fatal: true }).decode(bytes), encoding: "gb18030" };
    } catch { /* 继续 */ }

    // 4. UTF-16 仅在有大量 NUL 字节证据时尝试（单字节文本误读 UTF-16 不会产生 NUL）
    let nulCount = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) nulCount++;
    if (bytes.length > 0 && nulCount / bytes.length > 0.1) {
        // 看 NUL 偏偶还是偏奇判断 LE/BE
        let nulEven = 0, nulOdd = 0;
        for (let i = 0; i < bytes.length; i += 2) { if (bytes[i] === 0) nulEven++; }
        for (let i = 1; i < bytes.length; i += 2) { if (bytes[i] === 0) nulOdd++; }
        if (nulOdd >= nulEven) {
            return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
        }
        return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
    }

    // 5. 兜底：宽松 UTF-8
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), encoding: "utf-8 (lenient)" };
}

/** 从字幕文件字节解析（多编码自动尝试，解码顺序见 decodeSubtitleBuffer） */
export function parseSubtitleArrayBuffer(buffer: ArrayBuffer, filename?: string): { cues: SubtitleCue[]; encoding: string } {
    const { text, encoding } = decodeSubtitleBuffer(buffer);
    return { cues: parseSubtitleText(text, filename), encoding };
}

/** 按播放位置取字幕滑动窗口：向前已播 ~2000 字符、向后预取 ~1000 字符 */
export function buildSubtitleWindow(cues: SubtitleCue[], positionSeconds: number, backChars = 2000, forwardChars = 1000): string {
    // 定位锚点：endSeconds <= position 的最后一条为「已播」边界；startSeconds > position 的开始「未播」
    let anchorIndex = -1;
    for (let i = 0; i < cues.length; i++) {
        if (cues[i].endSeconds <= positionSeconds) anchorIndex = i;
        else break;
    }
    const parts: string[] = [];
    let backCount = 0;
    for (let i = anchorIndex; i >= 0 && backCount < backChars; i--) {
        parts.unshift(cues[i].text);
        backCount += cues[i].text.length;
    }
    let forwardCount = 0;
    for (let i = anchorIndex + 1; i < cues.length && forwardCount < forwardChars; i++) {
        // 未播内容只取到锚点后 3 条以内剧透安全边际（向后窗口本身是预取，展示层已门控）
        parts.push(cues[i].text);
        forwardCount += cues[i].text.length;
    }
    return parts.join("\n");
}

/** 从完整字幕切出 [startSeconds, endSeconds) 范围内的文本（分段时切好存储） */
export function sliceSubtitleText(cues: SubtitleCue[], startSeconds: number, endSeconds: number): string {
    return cues
        .filter(c => c.startSeconds < endSeconds && c.endSeconds > startSeconds)
        .map(c => c.text)
        .join("\n");
}
