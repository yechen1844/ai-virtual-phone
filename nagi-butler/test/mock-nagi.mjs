import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PORT || 17842);

const messages = [
  { sender: 'Player', text: '(历史消息) 早安呀', time: '2026-08-26T08:00:00.000Z' },
];
const pushed = [];

function json(res, code, obj) {
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
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/status') return json(res, 200, { worldReady: true });
    if (url.pathname === '/chat/history') return json(res, 200, { messages: [...messages] });
    if (url.pathname === '/chat/push' && req.method === 'POST') {
      const body = await readBody(req);
      const sender = String(body.sender ?? 'Nagi');
      const text = String(body.message ?? '');
      messages.push({ sender, text, time: new Date().toISOString() });
      pushed.push({ sender, text });
      console.log(`[mock] /chat/push <- [${sender}] ${text}`);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__simulate' && req.method === 'POST') {
      const body = await readBody(req);
      const msg = {
        sender: String(body.sender ?? 'Player'),
        text: String(body.text ?? ''),
        time: new Date().toISOString(),
      };
      messages.push(msg);
      console.log(`[mock] 模拟玩家在游戏里发言: [${msg.sender}] ${msg.text}`);
      return json(res, 200, { ok: true, count: messages.length });
    }
    if (url.pathname === '/_dump') return json(res, 200, { messages, pushed });
    return json(res, 404, { ok: false });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(port, () => console.log(`[mock] 假 NagiBridge 已启动 :${port}`));
