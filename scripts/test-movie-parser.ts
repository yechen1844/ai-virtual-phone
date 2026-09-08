// 临时测试：验证 movie-parser 对真实世界 SRT 的解析
import { parseSubtitleArrayBuffer, parseSubtitleText } from "../lib/movie-parser";
import { decodeTxtArrayBuffer } from "../lib/reading-parser";

// 构造真实世界 SRT：CRLF 换行、UTF-8 BOM、双语、序号行、空行分隔
const sampleSrt = "\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n今天天气很好\r\nThe weather is nice today\r\n\r\n2\r\n00:00:04,000 --> 00:00:07,250\r\n我们一起去公园散步吧\r\n\r\n3\r\n00:02:17,440 --> 00:02:20,375\r\nSenator, we're making our final approach.\r\n\r\n";
const bytes = new TextEncoder().encode(sampleSrt);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

console.log("=== decode layer ===");
const dec = decodeTxtArrayBuffer(buffer as ArrayBuffer);
console.log("encoding:", dec.encoding);
console.log("text head:", JSON.stringify(dec.text.slice(0, 80)));

console.log("=== parse layer (string input) ===");
const cues2 = parseSubtitleText(dec.text, "test.srt");
console.log("cue count:", cues2.length);

console.log("=== full path ===");
const { cues } = parseSubtitleArrayBuffer(buffer as ArrayBuffer, "test.srt");
console.log("cue count:", cues.length);
for (const c of cues) {
    console.log(`  [${c.startSeconds.toFixed(3)} -> ${c.endSeconds.toFixed(3)}] ${c.text.replace(/\n/g, " ⏎ ")}`);
}
if (cues.length !== 3) {
    console.error("!!! 解析结果与预期不符");
    process.exit(1);
}
console.log("PASS");
