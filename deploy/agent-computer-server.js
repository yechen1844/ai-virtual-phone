#!/usr/bin/env node
/**
 * agent-computer VPS 兼容服务（零依赖，Node.js >= 18，纯内置模块）
 *
 * 用途：在没有 Cloudflare 付费计划的情况下，把「角色电脑」跑在自己 2C2G 的 Linux VPS 上。
 * 协议与 Cloudflare Worker 模板完全兼容，float 里设置 → 角色电脑 → 填地址和密钥即可直连。
 * 每台电脑 = VPS 上的一个目录（workspace），shell 直接在 VPS 上执行 —— 真 Linux，等同容器模式。
 *
 * 环境变量：
 *   PORT                 监听端口，默认 8787
 *   AGENT_TOKEN          连接密钥（必须设置，float 里填的密钥）
 *   AGENT_COMPUTER_ROOT  数据根目录，默认 <本文件目录>/workspaces
 *   EXEC_TIMEOUT_MS      exec 超时（毫秒），默认 60000
 *
 * 启动：AGENT_TOKEN=你的密钥 node agent-computer-server.js
 * 公网访问：cloudflared tunnel --url http://localhost:8787  （免费 https 地址）
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.AGENT_TOKEN || "";
const ROOT = path.resolve(process.env.AGENT_COMPUTER_ROOT || path.join(__dirname, "workspaces"));
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS || 60000);
const MAX_OUTPUT_BYTES = 200 * 1024;     // exec stdout/stderr 各自上限
const MAX_BASE64 = 6 * 1024 * 1024;      // read_base64 上限 6MB
const MAX_BODY = 12 * 1024 * 1024;       // 请求体上限 12MB

fs.mkdirSync(ROOT, { recursive: true });

// ── 工具函数 ──

function workspaceDir(workspace) {
  // 冒号在 Windows 目录名里非法，统一替换成下划线；同一 workspace 映射恒定，float 端不关心目录名
  const safe = String(workspace || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  if (!safe) throw Object.assign(new Error("workspace 无效"), { status: 400, show: true });
  return path.join(ROOT, safe);
}

// 把请求里的相对路径安全地解析到 workspace 根目录内，杜绝目录穿越
function safeResolve(wsDir, rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const target = clean ? path.resolve(wsDir, clean) : wsDir;
  if (target !== wsDir && !target.startsWith(wsDir + path.sep)) {
    throw Object.assign(new Error("路径越界：" + rel), { status: 400, show: true });
  }
  return target;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

function fail(res, message, status = 200) {
  send(res, status, { ok: false, error: message });
}

// 读取请求体（带大小上限）
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体过大"), { status: 413, show: true }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 执行命令：bash -c，cwd=workspace 根目录，带超时与输出上限
function runCommand(cwd, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: true, exitCode: 124, stdout, stderr: stderr + "\n（命令超时，已终止）" });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString("utf8").slice(0, MAX_OUTPUT_BYTES - stdout.length);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString("utf8").slice(0, MAX_OUTPUT_BYTES - stderr.length);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, exitCode: code ?? -1, stdout, stderr });
    });
  });
}

// ── 各 action 处理 ──

async function handleAction(action, payload) {
  const workspace = String(payload.workspace || "");
  const wsDir = workspaceDir(workspace);
  await fsp.mkdir(wsDir, { recursive: true });

  switch (action) {
    case "status":
      return { ok: true, fs: true, shell: true, mode: "container" }; // VPS 上就是真 Linux

    case "list": {
      const dir = safeResolve(wsDir, payload.path || "/");
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      return {
        ok: true,
        entries: entries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({ name: e.name, dir: e.isDirectory() })),
      };
    }

    case "read": {
      const file = safeResolve(wsDir, payload.path);
      const raw = await fsp.readFile(file, "utf8").catch((err) => {
        throw Object.assign(new Error("读取失败：" + (err.code === "ENOENT" ? "文件不存在" : err.message)), { show: true });
      });
      const maxChars = Number.isFinite(Number(payload.maxChars)) ? Number(payload.maxChars) : 20000;
      const truncated = raw.length > maxChars;
      return { ok: true, content: truncated ? raw.slice(0, maxChars) : raw, truncated };
    }

    case "read_base64": {
      const file = safeResolve(wsDir, payload.path);
      const buf = await fsp.readFile(file).catch((err) => {
        throw Object.assign(new Error("读取失败：" + (err.code === "ENOENT" ? "文件不存在" : err.message)), { show: true });
      });
      if (buf.length > MAX_BASE64) throw Object.assign(new Error("文件超过 6MB，无法读取"), { show: true });
      return { ok: true, base64: buf.toString("base64") };
    }

    case "write": {
      const file = safeResolve(wsDir, payload.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (typeof payload.content === "string") {
        await fsp.writeFile(file, payload.content, "utf8");
      } else if (typeof payload.base64 === "string") {
        await fsp.writeFile(file, Buffer.from(payload.base64, "base64"));
      } else {
        throw Object.assign(new Error("缺少 content 或 base64"), { status: 400, show: true });
      }
      return { ok: true };
    }

    case "mkdir": {
      const dir = safeResolve(wsDir, payload.path);
      await fsp.mkdir(dir, { recursive: true });
      return { ok: true };
    }

    case "delete": {
      const target = safeResolve(wsDir, payload.path);
      await fsp.rm(target, { recursive: true, force: true });
      return { ok: true };
    }

    case "exec": {
      const command = String(payload.command || "").trim();
      if (!command) throw Object.assign(new Error("缺少 command"), { status: 400, show: true });
      return await runCommand(wsDir, command, EXEC_TIMEOUT_MS);
    }

    default:
      throw Object.assign(new Error("未知 action：" + action), { status: 400, show: true });
  }
}

// ── HTTP 入口 ──

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    fail(res, "仅支持 POST", 405);
    return;
  }

  // 鉴权
  const auth = req.headers.authorization || "";
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    fail(res, "未授权：AGENT_TOKEN 不匹配", 401);
    return;
  }

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    const action = String(payload.action || "").trim();
    const result = await handleAction(action, payload);
    send(res, 200, result);
  } catch (err) {
    const status = err.status || 200;
    const message = err.show ? err.message : (err instanceof Error ? err.message : String(err));
    if (!err.show) console.error("[agent-computer] 请求失败：", err);
    fail(res, message, status);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`agent-computer VPS 服务已启动：端口 ${PORT}，数据根目录 ${ROOT}`);
  console.log(`未设置 AGENT_TOKEN 时所有请求会被拒绝；请用 AGENT_TOKEN=xxx node agent-computer-server.js 启动`);
});
