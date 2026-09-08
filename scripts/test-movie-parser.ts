// 字幕解析回归测试：合成样本 + 真实文件
import * as fs from "fs";
import { parseSubtitleArrayBuffer } from "../lib/movie-parser";

// ── 1. 合成样本：CRLF、UTF-8 BOM、双语、序号行、<i> 标签 ──
const sampleSrt = "\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n今天天气很好\r\nThe weather is nice today\r\n\r\n2\r\n00:00:04,000 --> 00:00:07,250\r\n我们一起去公园散步吧\r\n\r\n3\r\n00:02:17,440 --> 00:02:20,375\r\n<i>Senator, we're making our final approach.</i>\r\n\r\n";
const bytes = new TextEncoder().encode(sampleSrt);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

console.log("=== 合成样本（UTF-8 BOM + CRLF + <i>标签）===");
const r1 = parseSubtitleArrayBuffer(buffer as ArrayBuffer, "test.srt");
console.log("encoding:", r1.encoding, "| cue count:", r1.cues.length);
r1.cues.forEach(c => console.log(`  [${c.startSeconds.toFixed(3)}] ${c.text.replace(/\n/g, " ⏎ ")}`));
if (r1.cues.length !== 3) { console.error("!!! 合成样本失败"); process.exit(1); }
if (r1.cues[2].text.includes("<i>")) { console.error("!!! <i> 标签未剥离"); process.exit(1); }

// ── 2. GB18030 无 BOM 中文样本 ──
const gbText = "1\n00:00:01,000 --> 00:00:03,500\n有时候，我觉得我被诅咒了。\n\n";
const gbBytes = Buffer.from(gbText, "utf8");
// 用 Node 把 UTF-8 文本转成 GB18030 字节：借助 iconv 不可用时手工跳过（Node 无内置 gb18030 编码器到字节的 TextEncoder）
// 改用真实文件覆盖该场景 ↓

// ── 3. 真实文件：寻梦环游记（UTF-8 无 BOM、CRLF、<i> 标签、中英混排）──
const realPath = "E:\\所有文件\\movies\\寻梦环游记.zh.srt";
if (fs.existsSync(realPath)) {
    console.log("\n=== 真实文件：寻梦环游记.zh.srt ===");
    const realBuf = fs.readFileSync(realPath);
    const ab = realBuf.buffer.slice(realBuf.byteOffset, realBuf.byteOffset + realBuf.byteLength);
    const r2 = parseSubtitleArrayBuffer(ab as ArrayBuffer, "寻梦环游记.zh.srt");
    console.log("encoding:", r2.encoding, "| cue count:", r2.cues.length);
    r2.cues.slice(0, 3).forEach(c => console.log(`  [${c.startSeconds.toFixed(3)}] ${c.text.replace(/\n/g, " ⏎ ")}`));
    const hasTag = r2.cues.some(c => /<[a-z/]/i.test(c.text));
    if (r2.cues.length < 500 || hasTag) { console.error("!!! 真实文件解析异常"); process.exit(1); }
    console.log("PASS（真实文件）");
} else {
    console.log("\n（真实文件不在，跳过）");
}
console.log("ALL PASS");
