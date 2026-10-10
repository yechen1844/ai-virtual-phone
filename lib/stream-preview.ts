// lib/stream-preview.ts
// 流式生成预览的文本净化：AI 回复里混着富媒体指令（[状态栏]/[内心]/[照片]）、
// 工具标签（[执行动作]/[获取指令]）等不直接给用户看的协议内容。流式增量是碎片，
// 标签可能未闭合，所以这里做的是「幂等净化」——对完整累积文本反复应用也安全：
// 已经剥掉的不会再剥，未闭合的标签残留会在下一批增量到来时随全文重算被清掉。

import { stripTextToolDirectives } from "./text-tool-protocol";

const TOOL_DIRECTIVE_START_RE = /\[[^\]\r\n]*?(?:执行动作|获取指令|获取工具|工具调用)\s*[:：]/;
const MEDIA_DIRECTIVE_RE = /\[(?:代付请求|音乐分享|语音条|表情包|照片|红包|转账|位置|名片|音乐|礼物)\s*[:：][^\]\r\n]*\]/g;
const INCOMPLETE_MEDIA_DIRECTIVE_RE = /\[(?:代付请求|音乐分享|语音条|表情包|照片|红包|转账|位置|名片|音乐|礼物)\s*[:：][^\]\r\n]*$/g;

/** 按标签名剥掉 <tag>…</tag> 整块（含未闭合的 <tag>…直到结尾），供思维链/摘要类
 *  配置型标签在预览阶段隐藏。幂等：已剥净的文本重复调用无变化。 */
export function stripXmlTagBlocks(text: string, tags: readonly string[]): string {
    let result = text;
    for (const tag of tags) {
        const trimmed = tag.trim();
        if (!trimmed) continue;
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi"), "");
        // 流式碎片阶段标签未闭合：从开标签起全部隐藏，等闭合后随全文重算恢复正文
        result = result.replace(new RegExp(`<${escaped}>[\\s\\S]*$`, "gi"), "");
    }
    return result;
}

/** 按字面量删除文本片段（预设 strip_texts）。与引擎 stripPresetTexts 同语义：
 *  纯 split/join，不走正则。预览侧供「先清洗原文再解析」使用，保证与最终清洗顺序一致。 */
export function stripLiteralTexts(text: string, literals: readonly string[]): string {
    let result = text;
    for (const literal of literals) {
        if (literal) result = result.split(literal).join("");
    }
    return result;
}

/** 按空行把净化后的预览文本切成「一段一条」，与最终解析（parseAIResponse 的
 *  \n\n+ 分段规则）同源：已经出现空行的段落在生成过程中即可定型为独立气泡，
 *  只有最后一段仍在打字。cleanStreamText 已把 3+ 连续换行压成空行，这里直接切。 */
export function splitStreamPreviewSegments(text: string): string[] {
    return text.split(/\n\n+/).map(seg => seg.trim()).filter(Boolean);
}

/** 流式预览节流器：把「每帧对累积全文重解析 + setState」降到约 intervalMs 一次。
 *
 *  背景：rAF 只保证「一帧最多一次」，但流式期间每帧都要对「已累积的全部文本」跑一遍
 *  解析（净化/群聊逐行正则/线下 XML），单帧成本随文本变长线性上升，等于每秒 60 次
 *  越来越贵的重算 + 整棵聊天组件重渲染 → 表现为「越写越卡、一顿一顿」。
 *
 *  行为：距上次执行不足 intervalMs 时直接丢弃这次调度（后续增量很快会再进来）；
 *  刻意不用「尾帧定时器」补救——那会在生成结束、预览已清空之后又补一次 setState，
 *  反而容易闪出陈旧预览。预览只是「正在打字」的临时呈现，最终正文由落库消息给出。 */
export function createStreamPreviewThrottle(intervalMs = 100) {
    let lastAt = 0;

    return {
        schedule(run: () => void): void {
            const now = performance.now();
            if (now - lastAt < intervalMs) return;
            lastAt = now;
            run();
        },
        /** 段落切换 / 停止生成 / 卸载时调用，让下一次调度立即生效。 */
        reset(): void {
            lastAt = 0;
        },
    };
}

export type StreamPreviewThrottle = ReturnType<typeof createStreamPreviewThrottle>;

/** 剥掉不在气泡正文里展示的协议标签，保留对话正文（含群聊 [角色名]: 前缀）。
 *  stripXmlTags：额外剥掉的配置型 XML 标签块（如预设的线上思维链标签）；
 *  stripLiterals：按字面量直接删除的文本片段（预设 strip_texts，与引擎最终清洗对齐）。
 *  两者都由调用方按当前会话生效的预设传入——净化器本身不猜协议标签名。 */
export function cleanStreamText(raw: string, options?: { stripXmlTags?: readonly string[]; stripLiterals?: readonly string[] }): string {
    if (!raw) return "";
    let text = raw;
    if (options?.stripXmlTags?.length) text = stripXmlTagBlocks(text, options.stripXmlTags);
    if (options?.stripLiterals?.length) text = stripLiteralTexts(text, options.stripLiterals);
    // 成对富媒体块整块剥掉
    text = text.replace(/\[状态栏\][\s\S]*?\[\/状态栏\]/gi, "");
    text = text.replace(/\[内心\][\s\S]*?\[\/内心\]/gi, "");
    // 单边开标签（还没闭合）也剥掉，避免预览里露出协议残片
    text = text.replace(/\[状态栏\][\s\S]*?$/gi, "");
    text = text.replace(/\[内心\][\s\S]*?$/gi, "");
    // 工具指令参数允许嵌套数组、括号及字符串里的 ]，复用项目统一解析器，不能用 [^]] 截断。
    text = stripTextToolDirectives(text);
    const incompleteTool = text.match(TOOL_DIRECTIVE_START_RE);
    if (incompleteTool?.index !== undefined) text = text.slice(0, incompleteTool.index);
    // 富媒体完整标签显示为附件占位；尚未闭合时也隐藏协议正文。
    text = text.replace(MEDIA_DIRECTIVE_RE, "📎 ");
    text = text.replace(INCOMPLETE_MEDIA_DIRECTIVE_RE, "📎 ");
    // 引用壳只隐藏标签，保留后面的实际回复。
    text = text.replace(/\[引用\s*[:：][^\]\r\n]*\]/g, "");
    text = text.replace(/\[引用\s*[:：][^\]\r\n]*$/g, "");
    // 动作标签（朋友圈/发帖/静默等）与拍一拍通知不进入正文预览。
    text = text.replace(/\[(?:发朋友圈|发微博|发帖|静默|骰子|领取红包|拒收红包|接受转账|领取转账|拒收转账|接受代付|拒绝代付)[^\]\r\n]*\]/g, "");
    text = text.replace(/\[[^\]\r\n]{0,32}拍了拍[^\]\r\n]*\]/g, "");
    // 行内状态值支持中文字段名，同时保留群聊的 [角色名]: 前缀。
    text = text.replace(/\[[^\]\r\n：:]{1,24}\s*[:：]\s*-?\d+(?:\.\d+)?\s*\]/g, "");
    // 压缩多余空行
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
}
