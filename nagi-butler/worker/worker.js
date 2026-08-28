const NAGI_KEY = 'nagi_bridge_2026';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/health') {
      return cors(json({ ok: true, service: 'nagi-bridge', time: Date.now() }));
    }

    const auth = request.headers.get('X-Nagi-Key');
    if (auth !== NAGI_KEY) {
      return cors(json({ ok: false, error: 'unauthorized' }, 401));
    }

    const kv = env.NAGI_KV;

    if (url.pathname === '/message' && request.method === 'POST') {
      const body = await request.json();
      const msgs = await getJson(kv, 'msgs:pending', []);
      msgs.push({ sender: body.sender || 'player', text: body.text || '', ts: body.ts || Date.now() });
      await kv.put('msgs:pending', JSON.stringify(msgs));
      return cors(json({ ok: true, count: msgs.length }));
    }

    if (url.pathname === '/messages' && request.method === 'GET') {
      const msgs = await getJson(kv, 'msgs:pending', []);
      await kv.put('msgs:pending', '[]');
      return cors(json({ ok: true, messages: msgs }));
    }

    if (url.pathname === '/reply' && request.method === 'POST') {
      const body = await request.json();
      const replies = await getJson(kv, 'replies:pending', []);
      replies.push({ sender: body.sender || 'Nagi', text: body.text || '', ts: body.ts || Date.now() });
      await kv.put('replies:pending', JSON.stringify(replies));
      return cors(json({ ok: true, count: replies.length }));
    }

    if (url.pathname === '/replies' && request.method === 'GET') {
      const replies = await getJson(kv, 'replies:pending', []);
      await kv.put('replies:pending', '[]');
      return cors(json({ ok: true, replies: replies }));
    }

    // ── 游戏状态快照（管家定时上报，float 工具读取）──

    // 管家上报 /state 快照
    if (url.pathname === '/state' && request.method === 'POST') {
      const body = await request.json();
      await kv.put('game:state', JSON.stringify({ ...body, ts: Date.now() }));
      return cors(json({ ok: true, savedAt: Date.now() }));
    }
    // float 工具读 /state 快照
    if (url.pathname === '/state' && request.method === 'GET') {
      const cached = await getJson(kv, 'game:state', null);
      if (!cached) return cors(json({ ok: false, stale: true, error: 'no state snapshot yet' }));
      return cors(json({ ok: true, ...cached }));
    }

    // 管家上报 /surroundings 快照
    if (url.pathname === '/surroundings' && request.method === 'POST') {
      const body = await request.json();
      await kv.put('game:surroundings', JSON.stringify({ ...body, ts: Date.now() }));
      return cors(json({ ok: true, savedAt: Date.now() }));
    }
    // float 工具读 /surroundings 快照
    if (url.pathname === '/surroundings' && request.method === 'GET') {
      const cached = await getJson(kv, 'game:surroundings', null);
      if (!cached) return cors(json({ ok: false, stale: true, error: 'no surroundings snapshot yet' }));
      return cors(json({ ok: true, ...cached }));
    }

    // float 让 char 在游戏聊天框说话 → 进回复队列，管家拉取后送游戏
    if (url.pathname === '/game-say' && request.method === 'POST') {
      const body = await request.json();
      const replies = await getJson(kv, 'replies:pending', []);
      replies.push({ sender: body.sender || 'Nagi', text: body.text || '', ts: body.ts || Date.now() });
      await kv.put('replies:pending', JSON.stringify(replies));
      return cors(json({ ok: true, count: replies.length }));
    }

    return cors(json({ ok: false, error: 'not found' }, 404));
  }
};

async function getJson(kv, key, def) {
  const v = await kv.get(key);
  if (!v) return def;
  try { return JSON.parse(v); } catch { return def; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function cors(resp) {
  const r = resp.clone();
  r.headers.set('access-control-allow-origin', '*');
  r.headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  r.headers.set('access-control-allow-headers', 'content-type,X-Nagi-Key');
  return r;
}
