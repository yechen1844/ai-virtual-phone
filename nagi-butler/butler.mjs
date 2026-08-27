import { readFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const cfgIdx = args.indexOf('--config');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const configPath = cfgIdx >= 0 ? resolve(args[cfgIdx + 1]) : join(scriptDir, 'config.json');

let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`[!] 读不到配置文件: ${configPath} (${e.message})`);
  process.exit(1);
}

const nagiUrl = String(cfg.nagibridgeUrl || 'http://localhost:7842').replace(/\/+$/, '');
const charName = String(cfg.charName || 'Nagi');
const outboxName = String(cfg.outboxFile || 'outbox.jsonl');
const outboxPath = resolve(dirname(configPath), outboxName);
const channelPort = Number(cfg.channelServer?.port ?? 9000);
const replyPort = Number(cfg.replyServer?.port ?? 7869);

const cloud = cfg.cloudRelay || {};
const cloudUrl = String(cloud.url || '').replace(/\/+$/, '');
const cloudKey = String(cloud.key || '');
const cloudPollMs = Number(cloud.pollIntervalMs ?? 1500);
const cloudEnabled = Boolean(cloudUrl && cloudKey);

try {
  appendFileSync(outboxPath, '', 'utf8');
} catch {}

const stats = { received: 0, uploaded: 0, replies: 0, delivered: 0, startedAt: new Date().toISOString() };

const log = (msg) =>
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);

function writeOutbox(entry) {
  try {
    appendFileSync(outboxPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    log(`⚠️ 写入记录文件失败: ${e.message}`);
  }
}

async function uploadToCloud(entry) {
  if (!cloudEnabled) return;
  try {
    await fetch(`${cloudUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Nagi-Key': cloudKey },
      body: JSON.stringify({ sender: entry.sender, text: entry.text, ts: entry.ts }),
      signal: AbortSignal.timeout(8000),
    });
    stats.uploaded += 1;
    log(`☁️  上行 → Worker: [${entry.sender}] ${entry.text}`);
  } catch (e) {
    log(`⚠️ 上行到云端失败: ${e.message}`);
  }
}

async function pushToGame(text, sender) {
  const res = await fetch(`${nagiUrl}/chat/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender, message: text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function pollCloudReplies() {
  if (!cloudEnabled) return;
  try {
    const res = await fetch(`${cloudUrl}/replies`, {
      headers: { 'X-Nagi-Key': cloudKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && Array.isArray(data.replies) && data.replies.length > 0) {
      for (const r of data.replies) {
        const text = String(r.text || '').trim();
        const sender = String(r.sender || charName);
        if (!text) continue;
        try {
          await pushToGame(text, sender);
          stats.delivered += 1;
          log(`📥  下行 ← Worker → 游戏: [${sender}] ${text}`);
        } catch (e) {
          log(`⚠️ 回复送进游戏失败: ${e.message}`);
        }
      }
    }
  } catch (e) {
    // 静默，避免刷屏
  }
  setTimeout(pollCloudReplies, cloudPollMs);
}

async function checkGame() {
  try {
    const res = await fetch(`${nagiUrl}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const d = await res.json();
    return d.worldReady === true;
  } catch {
    return false;
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 65536) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const channelServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { status: 'listening', service: 'nagi-butler-channel' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.message ?? body.text ?? '').trim();
      if (!text) return sendJson(res, 200, { ok: true });
      const sender = String(body.sender ?? body.name ?? '玩家');
      const entry = {
        ts: new Date().toISOString(),
        from: 'game',
        sender,
        text,
      };
      writeOutbox(entry);
      stats.received += 1;
      log(`💬 [${sender}] ${text} → 已记录`);
      await uploadToCloud(entry);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
});

channelServer.listen(channelPort, '127.0.0.1', () => {
  log('🚀 传话管家已启动');
  log(`   接收游戏消息: http://localhost:${channelPort}`);
  log(`   回复入口: http://localhost:${replyPort}/say`);
  log(`   游戏消息记录: ${outboxPath}`);
  log(`   游戏API: ${nagiUrl}`);
  if (cloudEnabled) {
    log(`   云端中转: ${cloudUrl} (每 ${cloudPollMs}ms 轮询回复)`);
  } else {
    log(`   云端中转: 未启用`);
  }
  log('   按 Ctrl+C 可随时退出');
  log('');
  if (cloudEnabled) pollCloudReplies();
});

const replyServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'nagi-butler',
        ...stats,
        cloudEnabled,
      });
    }
    if (url.pathname === '/say' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text ?? body.message ?? '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' });
      const sender = String(body.sender ?? body.name ?? charName);
      const gameReply = await pushToGame(text, sender);
      stats.replies += 1;
      log(`📤 [${sender}] ${text} → 已送进游戏聊天框`);
      return sendJson(res, 200, { ok: true, game: gameReply });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: e.message });
  }
});

replyServer.listen(replyPort, () => {
  log(`📡 回复服务已就绪 :${replyPort}`);
});

let gameReady = false;
let lastGameCheck = 0;
async function gameCheckLoop() {
  const now = Date.now();
  if (now - lastGameCheck > 5000) {
    lastGameCheck = now;
    const ready = await checkGame();
    if (ready && !gameReady) {
      gameReady = true;
      log(`✅ 游戏已就绪`);
    } else if (!ready && gameReady) {
      gameReady = false;
      log(`⏳ 游戏未就绪，等待中…`);
    } else if (!ready && !gameReady && now - (lastGameCheck - 5000) > 30000) {
      log(`⏳ 还没连上游戏（${nagiUrl}）。请确认游戏已启动并进入存档。`);
    }
  }
  setTimeout(gameCheckLoop, 5000);
}
gameCheckLoop();

process.on('SIGINT', () => {
  log('👋 管家下班啦，拜拜～');
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
