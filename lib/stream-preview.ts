// lib/stream-preview.ts
// 流式生成预览的文本净化：AI 回复里混着富媒体指令（[状态栏]/[内心]/[照片]）、
// 工具标签（[执行动作]/[获取指令]）等不直接给用户看的协议内容。流式增量是碎片，
// 标签可能未闭合，所以这里做的是「幂等净化」——对完整累积文本反复应用也安全：
// 已经剥掉的不会再剥，未闭合的标签残留会在下一批增量到来时随全文重算被清掉。

/** 剥掉不在气泡正文里展示的协议标签，保留对话正文（含群聊 [角色名]: 前缀） */
export function cleanStreamText(raw: string): string {
    if (!raw) return "";
    let text = raw;
    // 成对富媒体块整块剥掉
    text = text.replace(/\[状态栏\][\s\S]*?\[\/状态栏\]/gi, "");
    text = text.replace(/\[内心\][\s\S]*?\[\/内心\]/gi, "");
    // 单边开标签（还没闭合）也剥掉，避免预览里露出协议残片
    text = text.replace(/\[状态栏\][\s\S]*?$/gi, "");
    text = text.replace(/\[内心\][\s\S]*?$/gi, "");
    // 工具/媒体指令行
    text = text.replace(/\[(?:执行动作|获取指令|获取工具|工具调用)[:：][^\]]*\]/g, "");
    text = text.replace(/\[(?:照片|语音|红包|转账|位置|名片|音乐)[:：][^\]]*\]/g, "📎 ");
    // 动作标签（朋友圈/发帖/静默等），含不完整形态
    text = text.replace(/\[(?:发朋友圈|发微博|发帖|静默|骰子|拍一拍)[^\]]*\]/g, "");
    // 行内状态值 [name:value]
    text = text.replace(/\[[A-Za-z0-9_]{1,24}:\d+(?:\.\d+)?\]/g, "");
    // 压缩多余空行
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
}
