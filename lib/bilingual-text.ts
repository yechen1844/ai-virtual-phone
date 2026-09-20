export function containsChinese(text: string): boolean {
    return /[\u3400-\u9fff]/.test(text);
}

export function normalizeBilingualTextInput(text: string): string {
    return text.replace(/\\r\\n|\\n|\\r/g, "\n");
}

function splitSegmentedBilingualLine(line: string): { original: string; translated: string } | null {
    const parts = line.split("|").map(part => part.trim());
    if (parts.length < 2 || parts.some(part => !part)) return null;

    if (parts.length === 3) {
        const [originalLabel, mixedLabelAndOriginal, translatedValue] = parts;
        const colonIndex = mixedLabelAndOriginal.search(/[:：]/);
        if (colonIndex > 0 && containsChinese(translatedValue) && !containsChinese(originalLabel)) {
            const translatedLabel = mixedLabelAndOriginal.slice(0, colonIndex + 1).trim();
            const originalValue = mixedLabelAndOriginal.slice(colonIndex + 1).trim();
            if (translatedLabel && originalValue && containsChinese(translatedLabel)) {
                return {
                    original: `${originalLabel}: ${originalValue}`,
                    translated: `${translatedLabel} ${translatedValue}`,
                };
            }
        }
    }

    if (parts.length % 2 !== 0) return null;

    const originalParts: string[] = [];
    const translatedParts: string[] = [];
    let hasNonChineseOriginal = false;

    for (let index = 0; index < parts.length; index += 2) {
        const original = parts[index];
        const translated = parts[index + 1];
        if (!translated || !containsChinese(translated)) return null;
        if (!containsChinese(original)) hasNonChineseOriginal = true;
        originalParts.push(original);
        translatedParts.push(translated);
    }

    if (!hasNonChineseOriginal) return null;
    return {
        original: originalParts.join(" | "),
        translated: translatedParts.join(" | "),
    };
}

export function splitBilingualText(text: string): { original: string; translated: string } | null {
    const trimmed = normalizeBilingualTextInput(text).trim();
    if (!trimmed || trimmed.includes("```") || /<script\b|<style\b/i.test(trimmed)) return null;
    const firstPipe = trimmed.indexOf("|");
    if (firstPipe <= 0) return null;
    if (firstPipe === trimmed.lastIndexOf("|")) {
        const original = trimmed.slice(0, firstPipe).trim();
        const translated = trimmed.slice(firstPipe + 1).trim();
        if (!original || !translated) return null;
        if (!containsChinese(translated)) return null;
        return { original, translated };
    }
    if (trimmed.includes("\n")) {
        const originalLines: string[] = [];
        const translatedLines: string[] = [];
        let bilingualLineCount = 0;

        for (const rawLine of trimmed.split("\n")) {
            const line = rawLine.trim();
            if (!line) {
                originalLines.push("");
                translatedLines.push("");
                continue;
            }

            const linePipe = line.indexOf("|");
            if (linePipe > 0 && linePipe === line.lastIndexOf("|")) {
                const lineOriginal = line.slice(0, linePipe).trim();
                const lineTranslated = line.slice(linePipe + 1).trim();
                if (!lineOriginal || !lineTranslated || !containsChinese(lineTranslated)) return null;
                originalLines.push(lineOriginal);
                translatedLines.push(lineTranslated);
                bilingualLineCount += 1;
                continue;
            }

            if (line.includes("|")) {
                const segmented = splitSegmentedBilingualLine(line);
                if (!segmented) return null;
                originalLines.push(segmented.original);
                translatedLines.push(segmented.translated);
                bilingualLineCount += 1;
                continue;
            }

            originalLines.push(line);
            translatedLines.push(line);
        }

        if (bilingualLineCount === 0) return null;
        const original = originalLines.join("\n").trim();
        const translated = translatedLines.join("\n").trim();
        if (!original || !translated || !containsChinese(translated)) return null;
        return { original, translated };
    }
    const segmented = splitSegmentedBilingualLine(trimmed);
    if (segmented) return segmented;
    return null;
}

/** 会话级双语投喂模式：决定把内容喂给模型时取哪种语言（界面展示不受影响）。 */
export type TranslationFeedMode = "both" | "originalOnly" | "translatedOnly";

/**
 * 面向「自由文本注入」的双语裁剪（阅读批注 / 随笔 / 读书笔记等）。
 *
 * 与 applyTranslationFeedMode 的区别：多一道「原文必须是非中文」的保护。
 * 这些内容是自由文本，中文句子里出现一个竖线（如「他在犹豫|还是走了」）不该被当成
 * 双语格式而截断右半段；无法确认是「非中文原文 + 中文译文」时原样返回，
 * 宁可多注入，绝不误伤中文角色（中文文本本来就切不出双语，返回原样）。
 */
export function trimBilingualForFeed(content: string, mode?: TranslationFeedMode): string {
    if (!content || !mode || mode === "both") return content;
    const split = splitBilingualText(content);
    if (!split) return content;
    if (containsChinese(split.original)) return content;
    return mode === "originalOnly" ? split.original : split.translated;
}
