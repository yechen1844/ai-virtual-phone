import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, '..');
const tmpConfig = join(testDir, '.tmp-config.json');
const tmpOutbox = join(testDir, '.tmp-outbox.jsonl');

rmSync(tmpOutbox, { force: true });
writeFileSync(
  tmpConfig,
  JSON.stringify({
    nagibridgeUrl: 'http://localhost:17842',
    pollIntervalMs: 300,
    charName: 'Nagi',
    outboxFile: '.tmp-outbox.jsonl',
    replyServer: { port: 17869 },
    relays: [],
  }),
);

const mock = spawn(process.execPath, [join(testDir, 'mock-nagi.mjs')], {
  env: { ...process.env, MOCK_PORT: '17842' },
});
const butler = spawn(process.execPath, [join(rootDir, 'butler.mjs'), '--config', tmpConfig]);
for (const [name, child] of [['mock', mock], ['butler', butler]]) {
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[${name}!err] ${d}`));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readOutbox() {
  try {
    return readFileSync(tmpOutbox, 'utf8');
  } catch {
    return '';
  }
}


async function waitFor(label, fn, timeoutMs = 10000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`等待超时: ${label}`);
}

const getJson = async (url) => (await fetch(url)).json();
const postJson = async (url, body) =>
  (
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

const results = [];
function check(name, pass) {
  results.push({ name, pass });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
}

let exitCode = 0;
try {
  await waitFor('管家 health 就绪', async () => {
    const h = await getJson('http://localhost:17869/health');
    return h.ok && h.primed === true;
  });
  check('管家启动并完成首次同步', true);

  await sleep(500);
  const early = readOutbox();
  check('历史旧消息没有被误转发', !early.includes('(历史消息)'));

  await postJson('http://localhost:17842/__simulate', {
    sender: 'Player',
    text: '你好呀小管家',
  });
  await waitFor(
    '游戏新消息出现在 outbox',
    () => readOutbox().includes('你好呀小管家'),
  );
  check('游戏 → 管家 → 记录文件（防失忆上行）', true);

  const sayReply = await postJson('http://localhost:17869/say', { text: '我在呢～' });
  check('回复入口返回 ok', sayReply.ok === true);

  await waitFor('假游戏收到 chat/push', async () => {
    const dump = await getJson('http://localhost:17842/_dump');
    return dump.pushed.some((p) => p.sender === 'Nagi' && p.text === '我在呢～');
  });
  check('测试页 → 管家 → 游戏聊天框（下行）', true);

  const bad = await postJson('http://localhost:17869/say', {});
  check('空消息被拒绝(400)', bad.ok === false);
} catch (e) {
  console.error(`\n❌ 测试中断: ${e.message}`);
  results.push({ name: e.message, pass: false });
} finally {
  mock.kill();
  butler.kill();
}

console.log('\n========== 测试结果 ==========');
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`共 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
