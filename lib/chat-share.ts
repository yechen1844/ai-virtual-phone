export type MusicChatSharePayload = {
    type: "music";
    title: string;
    artist: string;
};

export type XiaohongshuNoteChatSharePayload = {
    type: "xiaohongshu_note";
    authorName: string;
    title: string;
    body: string;
    description?: string;
    noteType: "post" | "video";
    tags?: string[];
    imageAssetId?: string;
    coverIcon?: string;
    tone?: string;
};

export type ChatSharePayload = MusicChatSharePayload | XiaohongshuNoteChatSharePayload;

function compactShareText(value: string | undefined, fallback: string): string {
    const text = (value || "").replace(/\s+/g, " ").trim();
    return text || fallback;
}

const MAX_PROMPT_COMMENTS = 3;
const MAX_PROMPT_COMMENT_LEN = 60;

export function formatXiaohongshuShareForPrompt(input: {
    author?: string;
    title?: string;
    body?: string;
    description?: string;
    noteType?: "post" | "video";
    tags?: string[];
    hotComments?: { nickname: string; content: string; likedCount?: number | string }[];
    stats?: string;
}): string {
    const author = compactShareText(input.author, "未知作者");
    const title = compactShareText(input.title, "无标题");
    const body = compactShareText(input.body, "无正文内容");
    const description = compactShareText(input.description, "");
    const kindLabel = input.noteType === "video" ? "视频" : "图文";
    const segments = [
        `分享了一条小红书${kindLabel}帖子`,
        `作者：${author}`,
        `标题：${title}`,
        `正文内容：${body}`,
    ];
    const tags = (input.tags || []).filter(Boolean).slice(0, 6);
    if (tags.length) segments.push(`话题标签：${tags.map(t => "#" + t).join(" ")}`);
    const comments = (input.hotComments || []).filter(c => c.content).slice(0, MAX_PROMPT_COMMENTS);
    if (comments.length) {
        const rendered = comments.map(c => {
            const text = compactShareText(c.content, "").slice(0, MAX_PROMPT_COMMENT_LEN);
            const likes = c.likedCount ? `（${c.likedCount}赞）` : "";
            return `${compactShareText(c.nickname, "匿名用户")}说："${text}"${likes}`;
        });
        segments.push(`热门评论：${rendered.join("；")}`);
    }
    if (input.stats) segments.push(`互动数据：${input.stats}`);
    segments.push(`图片/视频描述：${description || "无"}`);
    return segments.join("，") + "。";
}
