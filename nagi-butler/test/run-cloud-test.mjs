import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, '..');
const tmpConfig = join(testDir, '.tmp-config.json');
const tmpOutbox = join(testDir, '.tmp-outbox.jsonl');
const CLOUD = 'https://nagi-bridge.luyi90720.workers.dev';
const KEY = 'nagi_bridge_2026';

rmSync(tmpOutbox, { force: true });
writeFileSync(
  tmpConfig,
  JSON.stringify({
    nagibridgeUrl: 'http://localhost:17842',
    charName: 'Nagi',
    outboxFile: '.tmp-outbox.jsonl',
    channelServer: { port: 19000 },
    replyServer: { port: 17869 },
    cloudRelay: { url: CLOUD, key: KEY, pollIntervalMs: 500 },
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
  try { return readFileSync(tmpOutbox, 'utf8'); } catch { return ''; }
}
async function waitFor(label, fn, timeoutMs = 15000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`等待超时: ${label}`);
}
const getJson = async (url) => (await fetch(url)).json();
const postJson = async (url, body) => (await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json();

const results = [];
function check(name, pass) {
  results.push({ name, pass });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
}

let exitCode = 0;
(async () => {
  try {
    // 空出云端队列（清残）
    await getJson(`${CLOUD}/messages`).catch(() => {});
    await getJson(`${CLOUD}/replies`).catch(() => {});

    await waitFor('butler health 就绪', async () => {
      const h = await getJson('http://localhost:17869/health');
      return h.ok === true;
    });
    check('管家启动', true);

    // 模拟玩家在游戏里说话：游戏(NagiBridge)会把消息 POST 到管家的 channel 端口 19000
    await postJson('http://localhost:19000/', { message: '早上好呀', sender: '卡尔' });
    await waitFor('outbox 有记录', () => readOutbox().includes('早上好呀'));
    check('游戏消息写入本地记录', true);

    // 管家应该上行到云端（轮询云端能看到）
    let uploaded = false;
    await waitFor('云端收到上行消息', async () => {
      const msgs = await getJson(`${CLOUD}/messages`).catch(() => ({ messages: [] }));
      uploaded = msgs.messages?.some((m) => m.text === '早上好呀');
      return uploaded;
    });
    check('管家上行到云端 Worker', true);

    // 模拟 char 在 float 侧生成的回复，推回云端
    await postJson(`${CLOUD}/reply`, { sender: 'Nagi', text: '在呢～今天天气不错' });
    await waitFor('管家拉取回复并送进游戏', async () => {
      const dump = await getJson('http://localhost:17842/_dump');
      return dump.pushed?.some((p) => p.sender === 'Nagi' && p.text === '在呢～今天天气不错');
    });
    check('管家拉取云端回复并送进游戏', true);

    console.log('\n========== 测试结果 ==========');
    for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
    const failed = results.filter((r) => !r.pass).length;
    console.log(`共 ${results.length} 项，失败 ${failed} 项`);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error(`\n❌ 测试中断: ${e.message}`);
    process.exit(1);
  } finally {
    mock.kill();
    butler.kill();
  }
})();
