// lib/mixology/prose.ts
// 独家特调 · 正文语义协议：App 自有解析器，创作者零正则。
//
// 五种标记（由官方杯型引导 AI 书写，装饰 CSS 只管上色）：
//   「对白」   → dialogue    *心声*   → thought（整句斜体）
//   【场景】   → scene（独占一行，渲染成 — 场景 — 的过场行）
//   ~强调~    → accent      其余     → narration（普通叙述）
// 状态栏块 [状态栏]...[/状态栏] 在解析正文前剥离，交给沙盒 iframe 渲染。

export type MixProseSegmentType = "dialogue" | "thought" | "accent" | "narration";

export type MixProseSegment = {
    type: MixProseSegmentType;
    text: string;
};

export type MixProseParagraph =
    | { type: "scene"; text: string }
    | { type: "text"; segments: MixProseSegment[] };

// 兼容旧标签（[小票]/[尾调]）、全角括号与标签内空格——模型输出没那么规矩
type TagFamily = { open: RegExp; close: RegExp; openLine: RegExp };

function makeFamily(names: string): TagFamily {
    return {
        open: new RegExp(`[\\[【]\\s*(?:${names})\\s*[\\]】]`, "g"),
        close: new RegExp(`[\\[【]\\s*\\/\\s*(?:${names})\\s*[\\]】]`, "g"),
        // 截断兜底只认"行首"的开标签，避免误伤正文里顺嘴提到的标签字样
        openLine: new RegExp(`(?:^|\\n)\\s*[\\[【]\\s*(?:${names})\\s*[\\]】]`, "g"),
    };
}

const TICKET_TAGS = makeFamily("状态栏|小票");
const ENCORE_TAGS = makeFamily("小剧场|尾调");

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
    re.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) last = m;
    return last;
}

/** 配对策略「最后闭合 + 它前面最近的开标签」，正文提及标签字样不会吞正文 */
function pullFamily(text: string, tags: TagFamily): { text: string; raw?: string } {
    let raw: string | undefined;
    for (;;) {
        const close = lastMatch(tags.close, text);
        if (!close) break;
        const open = lastMatch(tags.open, text.slice(0, close.index));
        if (!open) break;
        const inner = text.slice(open.index + open[0].length, close.index).trim();
        if (!raw && inner) raw = inner;
        text = (text.slice(0, open.index) + text.slice(close.index + close[0].length)).trim();
    }
    return { text, raw };
}

/** 从 AI 原文剥离状态栏与小剧场块；漏写闭合（生成截断）时走行首开标签兜底 */
export function extractMixBlocks(rawInput: string): { text: string; ticketRaw?: string; encoreRaw?: string } {
    const afterEncore = pullFamily(rawInput, ENCORE_TAGS);
    const afterTicket = pullFamily(afterEncore.text, TICKET_TAGS);
    let text = afterTicket.text;
    let ticketRaw = afterTicket.raw;
    let encoreRaw = afterEncore.raw;
    if (!ticketRaw || !encoreRaw) {
        const tOpen = ticketRaw ? null : lastMatch(TICKET_TAGS.openLine, text);
        const eOpen = encoreRaw ? null : lastMatch(ENCORE_TAGS.openLine, text);
        const pick = tOpen && eOpen ? (tOpen.index > eOpen.index ? "t" : "e") : tOpen ? "t" : eOpen ? "e" : null;
        if (pick) {
            const m = (pick === "t" ? tOpen : eOpen) as RegExpExecArray;
            const inner = text.slice(m.index + m[0].length).trim();
            if (inner) {
                if (pick === "t") ticketRaw = inner;
                else encoreRaw = inner;
                text = text.slice(0, m.index).trim();
            }
        }
    }
    return { text, ticketRaw, encoreRaw };
}

/** 兼容旧调用：只关心状态栏 */
export function extractMixTicket(raw: string): { text: string; ticketRaw?: string } {
    const result = extractMixBlocks(raw);
    return { text: result.text, ticketRaw: result.ticketRaw };
}

const INLINE_RE = /「([^」]*)」|\*([^*\n]+)\*|~([^~\n]+)~/g;

function parseInline(line: string): MixProseSegment[] {
    const segments: MixProseSegment[] = [];
    let cursor = 0;
    INLINE_RE.lastIndex = 0;
    for (let match = INLINE_RE.exec(line); match; match = INLINE_RE.exec(line)) {
        if (match.index > cursor) {
            segments.push({ type: "narration", text: line.slice(cursor, match.index) });
        }
        if (match[1] !== undefined) segments.push({ type: "dialogue", text: `「${match[1]}」` });
        else if (match[2] !== undefined) segments.push({ type: "thought", text: match[2] });
        else segments.push({ type: "accent", text: match[3] });
        cursor = match.index + match[0].length;
    }
    if (cursor < line.length) {
        segments.push({ type: "narration", text: line.slice(cursor) });
    }
    return segments;
}

/**
 * 把 AI 正文解析成段落序列。
 * 段落按空行/换行切分；整行被【】包裹的行视为场景过场，其余走内联解析。
 */
export function parseMixProse(text: string): MixProseParagraph[] {
    const paragraphs: MixProseParagraph[] = [];
    for (const rawLine of text.split(/\n+/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const scene = line.match(/^【(.+)】$/);
        if (scene) {
            paragraphs.push({ type: "scene", text: scene[1].trim() });
            continue;
        }
        const segments = parseInline(line);
        if (segments.length) paragraphs.push({ type: "text", segments });
    }
    return paragraphs;
}
