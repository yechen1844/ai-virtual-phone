import { readFileSync, appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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
// 回复推送目标：把 char 的发言/回复额外推到「第二个」星露谷实例（用户主机，通常 :7842）。
// 留空则只推 nagiUrl。工具动作(/nb/*,/script)仍只走 nagiUrl，只有 chat/push 回复走双推。
const replyPushUrl = String(cfg.replyPushUrl || '').replace(/\/+$/, '');
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

const stats = { received: 0, uploaded: 0, replies: 0, delivered: 0, updates: 0, startedAt: new Date().toISOString() };

// 玩家在游戏里说的话：channelServer 收到后先存这里，float 轮询 GET /inbox 拉走。
const gameInbox = [];

// ── think 中转：char_agent → 管家 → float 浏览器 → 管家 → char_agent ──
const thinkPending = new Map();   // id → {messages, tools, maxTurns, ts}
const thinkResults = new Map();   // id → {text, toolCalls, ts}
let thinkCounter = 0;

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
  // 双推：char 的回复/发言同时送进主控实例(nagiUrl)与用户主机(replyPushUrl)，避免串号只出现在一边。
  const targets = [nagiUrl, replyPushUrl].filter((u, i, arr) => u && arr.indexOf(u) === i);
  const results = [];
  let lastErr;
  for (const target of targets) {
    try {
      const res = await fetch(`${target}/chat/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender, message: text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      results.push(await res.json().catch(() => ({})));
    } catch (e) {
      lastErr = e;
    }
  }
  if (results.length === 0) throw lastErr || new Error('push failed');
  return results[0];
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

// 采集 NagiBridge 真实状态，上传到云端 Worker，供 float 工具读取
async function collectGameSnapshot() {
  if (!cloudEnabled || !gameReady) return;
  try {
    // 玩家状态（含时间/位置/财富/背包）
    const stRes = await fetch(`${nagiUrl}/state`, { signal: AbortSignal.timeout(6000) });
    if (stRes.ok) {
      const state = await stRes.json();
      await fetch(`${cloudUrl}/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Nagi-Key': cloudKey },
        body: JSON.stringify({ player: state.player, location: state.location, time: state.time, inventory: state.inventory }),
        signal: AbortSignal.timeout(8000),
      });
      stats.updates += 1;
    }
    // 周围环境（半径 5 足够聊天用）
    const suRes = await fetch(`${nagiUrl}/surroundings?radius=5`, { signal: AbortSignal.timeout(6000) });
    if (suRes.ok) {
      const surroundings = await suRes.json();
      await fetch(`${cloudUrl}/surroundings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Nagi-Key': cloudKey },
        body: JSON.stringify(surroundings),
        signal: AbortSignal.timeout(8000),
      });
    }
  } catch (e) {
    // 静默，避免刷屏；下次循环再试
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

/** 按监听端口找对应星露谷进程的主窗口，只截取该窗口，返回 PNG Buffer（截不到返回 null）。 */
function captureGameWindowPng(port) {
  return new Promise((resolvePromise) => {
    const tmpPng = join(tmpdir(), `nagi_shot_${port}_${Date.now()}.png`);
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) { Write-Output 'ERR_NO_CONN'; exit 0 }
$p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'ERR_NO_PROC'; exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SW {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
}
public struct RECT { public int Left, Top, Right, Bottom; }
"@
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR_NO_WINDOW'; exit 0 }
$r = [SW+RECT]::new()
[SW]::GetWindowRect($h, [ref]$r) | Out-Null
$w = [Math]::Max(1, $r.Right - $r.Left)
$hh = [Math]::Max(1, $r.Bottom - $r.Top)
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
try { [SW]::PrintWindow($h, $dc, 2) | Out-Null } finally { $g.ReleaseHdc($dc) }
$g.Dispose()
$bmp.Save('${tmpPng}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'OK'
    `;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\\"')}"`, { timeout: 20000, maxBuffer: 1024 * 1024 * 12 }, (err, stdout, stderr) => {
      if (err || !stdout.includes('OK')) {
        log(`截图失败 port=${port}: ${String(stdout || stderr || err || '').slice(0, 120)}`);
        try { if (existsSync(tmpPng)) unlinkSync(tmpPng); } catch {}
        return resolvePromise(null);
      }
      try {
        if (!existsSync(tmpPng)) return resolvePromise(null);
        const buf = readFileSync(tmpPng);
        try { unlinkSync(tmpPng); } catch {}
        resolvePromise(buf);
      } catch (e) {
        log(`截图读取失败: ${e.message}`);
        resolvePromise(null);
      }
    });
  });
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
      gameInbox.push(entry);
      log(`💬 [${sender}] ${text} → 已入队（等待 float 拉取）`);
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
    // float 发消息进游戏（玩家说话 / char 回复都走这里，同 /say）
    if (url.pathname === '/message' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text ?? body.message ?? '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' });
      const sender = String(body.sender ?? body.name ?? charName);
      const gameReply = await pushToGame(text, sender);
      stats.replies += 1;
      log(`📤 [${sender}] ${text} → 已送进游戏聊天框`);
      return sendJson(res, 200, { ok: true, game: gameReply });
    }
    // float 拉取玩家在游戏里说的话（有则返回并清空，无则空数组）
    if (url.pathname === '/inbox' && req.method === 'GET') {
      const messages = gameInbox.splice(0);
      return sendJson(res, 200, { ok: true, messages });
    }
    // 送礼聚合：先选中礼物物品，再与面前对象（NPC / 玩家）互动递送
    if (url.pathname === '/nb/gift' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const item = body && body.item ? String(body.item).trim() : '';
      if (!item) return sendJson(res, 400, { ok: false, error: 'item 不能为空' });
      try {
        await fetch(`${nagiUrl}/select`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: item }),
          signal: AbortSignal.timeout(6000),
        });
        const giftRes = await fetch(`${nagiUrl}/interact`, {
          method: 'POST',
          signal: AbortSignal.timeout(6000),
        });
        const text = await giftRes.text();
        res.writeHead(giftRes.status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end(text);
        return;
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: String((e && e.message) || e) });
      }
    }
    // 星露谷截图控制：给模型的工具结果只返回简短提示（不把 PNG 字节塞进上下文）；
    // 真实图片由 onToolExecution 调用 /nb/screenshot?target=... 单独拉取。
    if (url.pathname === '/nb/screenshotctl' && req.method === 'GET') {
      const target = String(url.searchParams.get('target') || 'self');
      return sendJson(res, 200, { ok: true, notice: `已按你的要求给「${target === 'user' ? 'user' : '你'}」截图，画面已保存供你看。` });
    }
    // 星露谷截图：按 target/port 抓对应游戏窗口，返回 PNG。
    // target=self => char 自己的游戏(7843)；target=user => 你的 host 游戏(replyPushUrl)。
    if (url.pathname === '/nb/screenshot' && req.method === 'GET') {
      const target = String(url.searchParams.get('target') || 'self');
      const urlPort = Number(url.searchParams.get('port'));
      const defaultPort = target === 'user'
        ? Number(new URL(replyPushUrl).port || 0)
        : Number(new URL(nagiUrl).port || 7843);
      const port = urlPort || defaultPort;
      if (!port) return sendJson(res, 400, { ok: false, error: '无法确定目标端口' });
      const png = await captureGameWindowPng(port);
      if (!png) return sendJson(res, 502, { ok: false, error: '截图失败（原窗口没在运行？）' });
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(png);
      return;
    }
    // 星露谷 user(host,7842) 侧工具转发：float 的 stardew_get_user_* 经此代理到用户主机 NagiBridge。
    // 与 /nb/*（char 自己的游戏 7843）分开，保证 "user" 相关的状态/周围读的是 host 游戏。
    if (url.pathname.startsWith('/ub/') && (req.method === 'GET' || req.method === 'POST') && replyPushUrl) {
      const targetPath = url.pathname.slice(4); // 去掉前缀 '/ub/'
      const targetUrl = `${replyPushUrl}/${targetPath}${url.search}`;
      let bodyObj;
      if (req.method === 'POST') {
        const raw = await readBody(req).catch(() => null);
        bodyObj = raw;
      }
      const targetRes = await fetch(targetUrl, {
        method: req.method,
        headers: bodyObj !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      const text = await targetRes.text();
      res.writeHead(targetRes.status, {
        'content-type': targetRes.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end(text);
      return;
    }
    // 星露谷工具转发：float 的 stardew_* 工具经此代理到 NagiBridge（绕开浏览器直连的 CORS 预检）
    if (url.pathname.startsWith('/nb/') && (req.method === 'GET' || req.method === 'POST')) {
      const targetPath = url.pathname.slice(4); // 去掉前缀 '/nb/'
      const targetUrl = `${nagiUrl}/${targetPath}${url.search}`;
      let bodyObj;
      if (req.method === 'POST') {
        const raw = await readBody(req).catch(() => null);
        bodyObj = raw;
      }
      const targetRes = await fetch(targetUrl, {
        method: req.method,
        headers: bodyObj !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      const text = await targetRes.text();
      res.writeHead(targetRes.status, {
        'content-type': targetRes.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end(text);
      return;
    }
    // 执行星露谷打包脚本（farm_row.py / water_crops.py / chop_trees.py …）—— 一次干完一整类活
    if (url.pathname === '/script' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.script || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'script 不能为空' });
      const scriptPath = join(scriptDir, 'nagi_scripts', `${name}.py`);
      if (!existsSync(scriptPath)) return sendJson(res, 404, { ok: false, error: `脚本不存在: ${name}.py` });
      const defaultPort = Number(new URL(nagiUrl).port || 7842);
      const port = Number(body.port || defaultPort);
      const argsArr = Array.isArray(body.args) ? body.args : (body.args ? String(body.args).split(/\s+/) : []);
      const cmd = `python "${scriptPath}" ${argsArr.map((a) => `"${a}"`).join(' ')} --port ${port}`;
      log(`⚙️ 执行脚本: ${name} (port ${port})`);
      const runResult = await new Promise((resolvePromise) => {
        exec(cmd, { cwd: scriptDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 300000, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
          resolvePromise({ ok: !err, error: err ? String(err.message || err).slice(0, 500) : undefined, stdout: String(stdout || '').slice(-2000), stderr: String(stderr || '').slice(-800) });
        });
      });
      return sendJson(res, 200, runResult);
    }
    // ── think 中转端点 ──
    // char_agent POST /think → 存队列，返回 id
    if (url.pathname === '/think' && req.method === 'POST') {
      const body = await readBody(req);
      const id = `think_${++thinkCounter}`;
      thinkPending.set(id, { messages: body.messages || [], tools: body.tools || [], maxTurns: body.maxTurns || 10, ts: Date.now() });
      log(`🧠 think 请求 #${id} (${(body.messages||[]).length} 条消息)`);
      return sendJson(res, 200, { ok: true, id });
    }
    // char_agent GET /think-result?id=xxx → 拿 float 处理结果（阻塞等 60s）
    if (url.pathname === '/think-result' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' });
      // 最多等 60 秒
      const deadline = Date.now() + 60000;
      const check = () => {
        if (thinkResults.has(id)) {
          const result = thinkResults.get(id);
          thinkResults.delete(id);
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (Date.now() > deadline) {
          return sendJson(res, 504, { ok: false, error: 'think timeout (float 未响应)' });
        }
        setTimeout(check, 500);
      };
      check();
      return;
    }
    // float 浏览器 GET /think-pending → 拉一个待处理的 think 请求
    if (url.pathname === '/think-pending' && req.method === 'GET') {
      for (const [id, req] of thinkPending) {
        thinkPending.delete(id);
        return sendJson(res, 200, { ok: true, id, ...req });
      }
      return sendJson(res, 200, { ok: true, empty: true });
    }
    // float 浏览器 POST /think-result → 提交处理结果
    if (url.pathname === '/think-result' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.id;
      if (!id || !thinkPending.has(id) && !thinkResults.has(id)) {
        // id 可能已经被拉走了，仍然存结果
      }
      thinkResults.set(id, { text: body.text || '', toolCalls: body.toolCalls || [], ts: Date.now() });
      log(`🧠 think 结果 #${id} → ${body.toolCalls?.length || 0} 个工具调用`);
      return sendJson(res, 200, { ok: true });
    }
    // float 浏览器 POST /memory → 回写记忆（简单存 outbox）
    if (url.pathname === '/memory' && req.method === 'POST') {
      const body = await readBody(req);
      writeOutbox({ ts: new Date().toISOString(), from: 'agent', ...body });
      return sendJson(res, 200, { ok: true });
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
  if (gameReady) await collectGameSnapshot();
  setTimeout(gameCheckLoop, 5000);
}
gameCheckLoop();

process.on('SIGINT', () => {
  log('👋 管家下班啦，拜拜～');
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
