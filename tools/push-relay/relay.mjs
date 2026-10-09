// tools/push-relay/relay.mjs
// Supabase Realtime 的透明 WebSocket 中转。
//
// 目的：把「手机 ── 蜂窝网跨境 ──> Supabase」改成「手机 ──> 本机（东京） ──> Supabase」。
// 跨境那一段从手机挪到机房，稳定性通常高一个数量级；客户端只需把主机名换成这台机。
//
// 特性：零依赖、对协议完全透明（不认识 Phoenix 帧，只做字节双向管道），
//       所以客户端的 join / 心跳 / 广播全部照原样工作，中转侧不需要任何密钥。
//
// 用法（Node 18+）：
//   TARGET_HOST=xxxxxxxx.supabase.co PORT=8790 node relay.mjs
// 放在 systemd 里跑，前面用 nginx 443 终止 TLS（见本文件末尾的 nginx 片段）。

import http from "node:http";
import tls from "node:tls";

const PORT = Number(process.env.PORT || 8790);
const TARGET_HOST = (process.env.TARGET_HOST || "").trim();
const TARGET_PORT = Number(process.env.TARGET_PORT || 443);
/** 只放行这个前缀的路径，避免被当成任意转发器滥用 */
const ALLOW_PREFIX = process.env.ALLOW_PREFIX || "/realtime/";

if (!TARGET_HOST) {
  console.error("[relay] 缺少 TARGET_HOST（形如 xxxx.supabase.co）");
  process.exit(1);
}

/** 转发时强制改写的头（其余原样保留，尤其 Upgrade / Sec-WebSocket-* 必须保留） */
function rewriteHeader(name, value) {
  // Supabase 前面是 Kong，按 Host 路由；必须改成目标域名，否则 404
  if (name.toLowerCase() === "host") return TARGET_HOST;
  return value;
}

function log(...args) {
  console.log(`[relay] ${new Date().toISOString()}`, ...args);
}

const server = http.createServer((req, res) => {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("push-relay: websocket only\n");
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";
  if (!url.startsWith(ALLOW_PREFIX)) {
    log(`拒绝 ${url}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  log(`upgrade ${url.split("?")[0]} → ${TARGET_HOST}`);

  const upstream = tls.connect(
    { host: TARGET_HOST, port: TARGET_PORT, servername: TARGET_HOST },
    () => {
      // 原样重放握手：保留全部头（含 Upgrade / Sec-WebSocket-Key / apikey 查询串），只改 Host
      const lines = [`${req.method} ${url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${rewriteHeader(req.rawHeaders[i], req.rawHeaders[i + 1])}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      // 握手之后就是纯字节管道
      socket.pipe(upstream);
      upstream.pipe(socket);
    },
  );

  let closed = false;
  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    log(`关闭连接（${reason}）`);
    socket.destroy();
    upstream.destroy();
  };

  upstream.on("error", (err) => {
    console.warn("[relay] upstream error:", err.message);
    shutdown("upstream error");
  });
  socket.on("error", () => shutdown("client error"));
  socket.on("close", () => shutdown("client close"));
  upstream.on("close", () => shutdown("upstream close"));
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT} → ${TARGET_HOST}:${TARGET_PORT}${ALLOW_PREFIX}`);
});

// ── nginx（443 → 本进程），加在现有 server 块里即可 ──
//
// location /realtime/ {
//     proxy_pass http://127.0.0.1:8790;
//     proxy_http_version 1.1;
//     proxy_set_header Upgrade $http_upgrade;
//     proxy_set_header Connection "upgrade";
//     proxy_set_header Host $host;
//     proxy_read_timeout 3600s;
//     proxy_send_timeout 3600s;
//     proxy_buffering off;
// }
//
// ── systemd（/etc/systemd/system/push-relay.service）──
//
// [Unit]
// Description=Supabase Realtime push relay
// After=network-online.target
//
// [Service]
// Environment=TARGET_HOST=xxxxxxxx.supabase.co
// Environment=PORT=8790
// ExecStart=/usr/bin/node /opt/push-relay/relay.mjs
// Restart=always
// RestartSec=3
//
// [Install]
// WantedBy=multi-user.target
//
// ── 站点侧 ──
// 给 float 站点加环境变量 PUSH_RELAY_URL=wss://vertex.chajianreader.cc.cd
// （只填到主机名，路径由客户端自动拼 /realtime/v1/websocket），重新部署即生效。
