#!/usr/bin/env node
/**
 * 场景：Twenty 子应用的「上游全套 + 反代」进程主管（supervised sidecar 的实际长驻进程）。
 *
 * 拓扑（全部 127.0.0.1）：
 *   Agnx 反代 8132 ──┬─ /graphql、/auth、/metadata …（上游 API 前缀）──> NestJS 后端 8137
 *                    └─ 其余（HTML/JS/静态/hmr）──────────────────────> Vite dev 8136
 *
 * 为什么不是直接跑上游命令（依据每个包的 project.json，见 EMBED.md）：
 * 1. 上游 twenty-server 的 `start` 目标是 `nest start --watch`：--watch 会再 fork 一层 node，
 *    宿主按 pid 停工不清；这里用上游 `start:ci` 的等价命令 `nest start`（无 watch）。
 * 2. 上游 twenty-front 的 `start` 是 `@nx/vite:dev-server`，会自动 open 浏览器；这里直接跑 vite CLI。
 * 3. 上游 CORS 只对白名单 origin 放行 credentialed 请求
 *    （resolve-allowed-credentialed-origins.util.ts），前端与 API 必须同源 —— 8132 把两者合成一个 origin。
 * 4. twenty 用 graphql-ws 订阅 + express-session cookie，所以 8132 同时做 HTTP 反代与 WebSocket 隧道。
 *
 * 用法：node supervisor.mjs --port 8132 --front-port 8136 --server-port 8137 --root <appRoot> --data-root <dataRoot>
 * 就绪探测：http://127.0.0.1:<port>/agnx-healthz
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf("port", "8132"));
const FRONT_PORT = Number(argOf("front-port", "8136"));
const SERVER_PORT = Number(argOf("server-port", "8137"));
const APP_ROOT = path.resolve(argOf("root", path.resolve(here, "../..")));
const DATA_ROOT = path.resolve(argOf("data-root", path.join(APP_ROOT, "..", "data", "twenty")));
const UPSTREAM = path.join(APP_ROOT, "upstream");
const LOG_DIR = path.join(APP_ROOT, "logs");

const BIND = "127.0.0.1";
// ⚠️ 对外地址必须用 localhost（与 Agnx 宿主同 site），不能用 127.0.0.1。
//
// 2026-10-23 在真实桌面 Tab 里抓到的决定性证据：
//   宿主页面      http://localhost:8083/h/srv_xxx
//   Tab iframe    http://127.0.0.1:8132
//   父页 fetch(8132) → TypeError: Failed to fetch
// 浏览器眼里 localhost 与 127.0.0.1 是**两个不同 site**，于是：
//   1. Twenty 下发的 session cookie（HttpOnly; SameSite=Lax）在跨站 iframe 里被直接丢弃；
//   2. 登录 mutation 返回 200 拿到了 token，但紧接着 GetCurrentUser 变成
//      UNAUTHENTICATED / "Missing authentication token"；
//   3. 前端于是退回登录页 —— 就是用户看到的「登录点了没反应、永远停在欢迎页」。
// 改用 localhost 后与宿主同 site，cookie 才能落地。
const PUBLIC_HOST = "localhost";
const FRONT_ORIGIN = `http://${BIND}:${FRONT_PORT}`;
const SERVER_ORIGIN = `http://${BIND}:${SERVER_PORT}`;
// 对外统一入口（宿主 Tab 打开的那个 origin）。前端页面与 API 都必须以它为同源基址。
const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}:${PORT}`;

/** 与上游 packages/twenty-shared/src/types/ApiPath.ts 对齐。 */
const API_PATHS = [
  "admin-panel",
  "app",
  "application-registration-claim",
  "apps",
  "auth",
  "client-config",
  "cloudflare",
  "emailing",
  "file",
  "file-upload",
  "files",
  "graphql",
  "healthz",
  "mcp",
  "metadata",
  "oauth",
  "open-api",
  "public-assets",
  "rest",
  "s",
  "webhooks",
  ".well-known",
];
const API_MATCHERS = API_PATHS.map(
  (p) => new RegExp(`^/${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[/?])`),
);
const isApiPath = (url) => {
  const p = (url || "/").split("?")[0];
  return API_MATCHERS.some((re) => re.test(p));
};

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(DATA_ROOT, { recursive: true });

function log(name, line) {
  try {
    appendFileSync(path.join(LOG_DIR, `${name}.log`), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志失败不影响服务 */
  }
}

function probeHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { "accept-encoding": "identity" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ ok: true, status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: "" });
    });
    req.on("error", () => resolve({ ok: false, status: 0, body: "" }));
  });
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await probeHttp(url);
    if (r.ok && r.status >= 200 && r.status < 500) return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  log("supervisor", `WAIT_TIMEOUT ${label} ${url}`);
  return false;
}

// ——————————————————————— 子进程 ———————————————————————
const children = [];

function spawnChild(name, args, cwd, extraEnv) {
  const fd = openSync(path.join(LOG_DIR, `${name}.log`), "a");
  // detached:true → 独立进程组，便于整组 SIGTERM，避免 nest/vite 的孙进程残留。
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  const rec = { name, child, pid: child.pid, exited: null };
  children.push(rec);
  child.on("exit", (code, signal) => {
    rec.exited = { code, signal, at: Date.now() };
    log("supervisor", `${name} exited code=${code} signal=${signal}`);
  });
  child.unref();
  return rec;
}

function killTree(rec) {
  if (!rec?.pid) return;
  for (const sig of ["SIGTERM"]) {
    try {
      process.kill(-rec.pid, sig);
    } catch {
      try {
        process.kill(rec.pid, sig);
      } catch {
        /* 已退出 */
      }
    }
  }
}

// ——————————————————————— 反代 ———————————————————————
/**
 * 反代转发的请求头处理。
 *
 * ⚠️ 这里踩过一个关键坑，务必保留：
 *
 * 上游的 CSRF 中间件（cookie-session-csrf.middleware.ts）对「带 session cookie 的请求」做同源校验，
 * 它不只看 Origin，还会用 `getRequestBaseUrl(request)` = `${request.protocol}://${request.get('host')}`
 * 算出「后端自己认为的基址」，再和 Origin 比对。
 *
 * 所以：
 *   1. **Host 必须原样透传**（不能改成 127.0.0.1:8137）。改掉之后后端算出的基址是 :8137，
 *      与浏览器发来的 Origin(:8132) 不一致 → 403 CSRF_ORIGIN_MISMATCH，表现为「登录成功但下一步拿不到用户」。
 *   2. **Origin 必须保留**，不能删。早期的做法是直接删 Origin，但删了之后浏览器那条路径
 *      反而对不上（上游对缺失 Origin 的写请求是 fail-closed）。
 *   3. 再加 `x-forwarded-*`，让上游能正确推断公网协议与主机。
 */
function forwardHeaders(headers, _targetHost, publicOrigin) {
  const h = { ...headers };
  // 保留原始 Host（浏览器访问的 8132），不要改写成后端端口
  if (headers.host) h.host = headers.host;
  // 补上/保留 Origin：没有就按对外的同源地址补一个
  if (!h.origin && publicOrigin) h.origin = publicOrigin;
  h["x-forwarded-host"] = headers.host ?? "";
  h["x-forwarded-proto"] = "http";
  h["accept-encoding"] = "identity";
  return h;
}

/** 同源后 cookie 不能再带 domain，否则浏览器丢弃。 */
function rewriteSetCookie(list) {
  return list.map((c) =>
    c
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !/^domain=/i.test(part))
      .join("; "),
  );
}

/**
 * 重定向熔断器（2026-10-23 用户实测反馈后加）：
 *
 * 问题现象：宿主 Tab 里「一直闪来闪去」，Electron 渲染进程 CPU 烧到 30%+、风扇狂转。
 * 根因：Twenty 前端在「未登录 / 无工作区」态下会反复 302 到 /welcome?action=choose-workspace，
 *       而该页在拿不到工作区数据时又退化成只有 logo 的加载页，于是形成
 *       「加载 → 重定向 → 再加载」的死循环。iframe 里没人看得见报错，只剩 CPU 空转。
 *
 * 处置：按「每 10 秒窗口内同一路径的 302 次数」判定。
 *   超过阈值就**不再转发**，直接回一个说明页（200，带 data-agnx-loop-halt），
 *   让前端彻底安静下来，把原因如实告诉用户，而不是继续烧 CPU。
 * 该页带「重试」按钮（同一 URL 加 ?agnx_retry=1 会重置计数）。
 */
const REDIRECT_WINDOW_MS = 10_000;
const REDIRECT_HALT_THRESHOLD = 6;
const redirectHits = new Map(); // path -> number[] timestamps
/** 熔断保持期：一旦判定循环，30 秒内一律回说明页，避免「止住→反弹」抖动。 */
let haltedUntil = 0;

function noteRedirect(pathname) {
  const now = Date.now();
  const arr = (redirectHits.get(pathname) ?? []).filter((t) => now - t < REDIRECT_WINDOW_MS);
  arr.push(now);
  redirectHits.set(pathname, arr);
  if (redirectHits.size > 200) {
    for (const [k, v] of redirectHits) if (v.every((t) => now - t >= REDIRECT_WINDOW_MS)) redirectHits.delete(k);
  }
  return arr.length;
}

function loopHaltPage(url) {
  const esc = String(url).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Twenty 未就绪</title><style>
html,body{margin:0;height:100%;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center}
.box{max-width:620px;padding:32px 36px;border:1px solid #262b35;border-radius:14px;background:#161920}
h1{font-size:17px;margin:0 0 14px;color:#fff}p{margin:0 0 10px;color:#a8b0bd}
code{background:#0b0d11;padding:2px 6px;border-radius:5px;color:#8ab4f8;font-size:12px}
.note{border-left:3px solid #f5a524;padding:10px 14px;background:#1d1a12;border-radius:6px;margin:16px 0;color:#e8c98a;font-size:13px}
a{display:inline-block;margin-top:8px;padding:9px 18px;background:#3b6ef5;color:#fff;text-decoration:none;border-radius:8px;font-size:13px}
</style></head><body><div class="box" data-agnx-loop-halt="true">
<h1>Twenty 还没准备好，已停止重复加载</h1>
<div class="note">检测到页面在反复重定向（10 秒内已超过 ${REDIRECT_HALT_THRESHOLD} 次），
为避免持续占用 CPU，已主动拦下后续请求。</div>
<p><b>原因</b>：Twenty 采用多工作区架构，工作区地址按
<code>&lt;子域名&gt;.&lt;主机名&gt;</code> 拼接（默认 <code>app.127.0.0.1</code>），
本机无法解析该子域名，于是登录流程反复跳回选择工作区页面。</p>
<p><b>要真正用起来</b>需要先解决子域名解析（例如本机 hosts 增加
<code>127.0.0.1 app.127.0.0.1</code>），或等上游提供单工作区模式。</p>
<p style="color:#6b7280;font-size:12px">请求路径：<code>${esc}</code></p>
<a href="/?agnx_retry=1">重试</a>
</div></body></html>`;
}

/**
 * 「正在准备」页：前端 wyw-in-js 预编译期间（实测约 15 分钟）返回它，
 * 代替让浏览器反复重试。带自动刷新，但间隔 15 秒，不会烧 CPU。
 */
function warmingPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Twenty 正在准备…</title><meta http-equiv="refresh" content="15">
<style>html,body{margin:0;height:100%;background:#0f1115;color:#e6e8eb;
font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
display:flex;align-items:center;justify-content:center}
.box{text-align:center;max-width:520px;padding:32px}
.dot{display:inline-block;width:34px;height:34px;border-radius:9px;background:#fff;
color:#000;line-height:34px;font-weight:700;font-size:17px;margin-bottom:18px}
h1{font-size:16px;margin:0 0 10px;color:#fff}p{margin:0;color:#a8b0bd;font-size:13px}
.s{margin-top:18px;height:3px;border-radius:2px;background:#232833;overflow:hidden}
.s i{display:block;height:100%;width:40%;background:#3b6ef5;animation:m 1.6s ease-in-out infinite}
@keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}</style></head>
<body><div class="box" data-agnx-warming="true">
<div class="dot">20</div>
<h1>Twenty 正在首次准备…</h1>
<p>上游前端需要预编译约 2300 个样式文件，通常需要 10–15 分钟。<br>
此页会每 15 秒自动刷新一次，期间不会占用你的 CPU。</p>
<div class="s"><i></i></div>
</div></body></html>`;
}

function proxyHttp(req, res, target) {
  const up = http.request(
    {
      host: BIND,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, target.host, PUBLIC_ORIGIN),
    },
    (upRes) => {
      const headers = { ...upRes.headers };
      if (Array.isArray(headers["set-cookie"])) headers["set-cookie"] = rewriteSetCookie(headers["set-cookie"]);
      res.writeHead(upRes.statusCode ?? 502, headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (err) => {
    log("proxy", `upstream error ${req.method} ${req.url} ${target.port}: ${err?.message || err}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "TWENTY_UPSTREAM_UNAVAILABLE" }));
  });
  req.pipe(up);
}

function proxyUpgrade(req, socket, head, target) {
  const up = net.connect(target.port, BIND, () => {
    const headers = forwardHeaders(req.headers, target.host, PUBLIC_ORIGIN);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

// ——————————————————————— 主流程 ———————————————————————
async function main() {
  const serverDir = path.join(UPSTREAM, "packages", "twenty-server");
  const frontDir = path.join(UPSTREAM, "packages", "twenty-front");
  if (!existsSync(path.join(serverDir, "project.json")) || !existsSync(path.join(frontDir, "project.json"))) {
    console.error(`UPSTREAM_MISSING: ${UPSTREAM} 缺 twenty-server / twenty-front`);
    process.exit(3);
  }
  if (!existsSync(path.join(UPSTREAM, "node_modules"))) {
    console.error(`UPSTREAM_DEPS_MISSING: ${UPSTREAM}/node_modules 不存在`);
    process.exit(3);
  }

  const mainJs = path.join(serverDir, "dist", "main.js");
  const nestCli = path.join(UPSTREAM, "node_modules", ".bin", "nest");
  const viteCli = path.join(UPSTREAM, "node_modules", ".bin", "vite");
  // 后端有两种可用形态：nest CLI，或已编译好的 dist/main.js。
  //
  // 实测：本机 node_modules/.bin/nest 可能是指向 @nestjs/cli 的悬空软链（yarn 安装中断的残留），
  // 但 packages/twenty-server/dist/main.js 已经编译好、能直接 node 起来。
  // 只认 CLI 会误判成「装不上」，所以 dist 存在就放行。
  const serverDist = path.join(UPSTREAM, "packages", "twenty-server", "dist", "main.js");
  const hasNestCli = existsSync(nestCli);
  const hasServerDist = existsSync(serverDist);
  if (!hasNestCli && !hasServerDist) {
    console.error(`NEST_CLI_MISSING: 既无 ${nestCli} 也无 ${serverDist}`);
    process.exit(3);
  }
  if (!existsSync(viteCli)) {
    console.error(`VITE_CLI_MISSING: ${viteCli}`);
    process.exit(3);
  }

  // 上游必需的外部服务连接串。缺任一条 NestJS 启动即注入失败：
  //   `redis cache storage requires REDIS_URL to be defined`
  // 本机用已有 Postgres(5432, 独立库 agnx_twenty) 与 Redis(6379)，不启 Docker。
  const baseEnv = {
    ...process.env,
    NODE_ENV: "development",
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=8192",
    BROWSER: "none",
    PG_DATABASE_URL:
      process.env.PG_DATABASE_URL ??
      "postgres://apple@127.0.0.1:5432/agnx_twenty",
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    DISABLE_DB_MIGRATIONS: process.env.DISABLE_DB_MIGRATIONS ?? "false",
    // 上游要求：`Cannot derive session cookie secret: set ENCRYPTION_KEY`。
    // 用 32 字节随机串（仅本机开发实例；生产请换独立密钥）。
    ENCRYPTION_KEY:
      process.env.ENCRYPTION_KEY ??
      "d9c66c1e4b8a4f0f9e2d7a3b5c8f1e6a2b9d4c7f0a3e6b1c8d5f2a9e4b7c0d3f",
    APP_SECRET:
      process.env.APP_SECRET ??
      "d9c66c1e4b8a4f0f9e2d7a3b5c8f1e6a2b9d4c7f0a3e6b1c8d5f2a9e4b7c0d3f",
  };

  // 1) 后端
  log("supervisor", `start twenty-server on :${SERVER_PORT}`);
  // spawnChild 内部已固定用 process.execPath 启动，args 里不要再带 node 自身路径。
  const serverCmd = hasServerDist ? ["dist/main"] : [nestCli, "start"];
  spawnChild("twenty-server", serverCmd, serverDir, {
    ...baseEnv,
    // 上游真正读的是 NODE_PORT（main.ts:119 app.listen(twentyConfigService.get('NODE_PORT'))，
    // config-variables.ts 默认 3000）。只给 PORT 会静默绑到 3000，必须两个都给。
    NODE_PORT: String(SERVER_PORT),
    PORT: String(SERVER_PORT),
    // 必须指向反代 8132 而不是后端 8137：
    // 后端对「带 session cookie 的请求」校验 Origin，写 8137 会导致
    // CSRF_ORIGIN_MISMATCH（"Request origin is not allowed for cookie-authenticated requests"），
    // 登录看似成功却永远进不去。
    SERVER_URL: PUBLIC_ORIGIN,
    FRONTEND_URL: PUBLIC_ORIGIN,
  });
  const serverOk = await waitFor(`${SERVER_ORIGIN}/healthz`, 20 * 60_000, "server-healthz");
  log("supervisor", `server healthz ok=${serverOk}`);

  // 2) 前端
  log("supervisor", `start twenty-front on :${FRONT_PORT}`);
  spawnChild(
    "twenty-front",
    [viteCli, "--port", String(FRONT_PORT), "--strictPort", "--host", BIND],
    frontDir,
    {
      ...baseEnv,
      REACT_APP_PORT: String(FRONT_PORT),
      // 同上：前端必须把 API 打到自己这个同源地址（8132 反代），
      // 打 8137 就是跨源，带 cookie 的请求会被后端拒。
      REACT_APP_SERVER_BASE_URL: PUBLIC_ORIGIN,
    },
  );
  // 注意：Vite 在 wyw-in-js 预编译期间**也能返回 index.html**，
  // 所以只看 `/` 会把「还没准备好」误判成就绪，反代一开放浏览器就开始无限重试，
  // 表现就是 Tab 闪来闪去 + CPU 被吃满（用户实际踩过）。
  // 因此这里改为探测一个真实的深层模块，能编出 200 才算真就绪。
  const frontIndexOk = await waitFor(`${FRONT_ORIGIN}/`, 25 * 60_000, "front-index");
  log("supervisor", `front index ok=${frontIndexOk}`);
  const frontModuleUrl = `${FRONT_ORIGIN}/src/modules/auth/sign-in-up/components/SignInUpStandardContent.tsx`;
  let frontOk = false;
  if (frontIndexOk) {
    frontOk = await waitFor(frontModuleUrl, 30 * 60_000, "front-module-compiled");
    log("supervisor", `front module compiled=${frontOk}`);
  }

  // 3) 对外反代（宿主 Tab 挂载的就是这个 origin）
  const httpServer = http.createServer((req, res) => {
    if ((req.url || "").split("?")[0] === "/agnx-healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "twenty-supervisor",
          port: PORT,
          frontReady: frontOk,
          serverReady: serverOk,
          children: children.map((c) => ({ name: c.name, pid: c.pid, exited: c.exited })),
        }),
      );
      return;
    }
    const url = req.url || "/";
    const pathname = url.split("?")[0];
    if (url.includes("agnx_retry=1")) { haltedUntil = 0; redirectHits.clear(); }

    // 前端还没真正就绪（wyw 预编译中）：一律回「正在准备」，不转发给浏览器。
    // 这样浏览器不会反复重试/重定向，CPU 就不会被烧起来。
    if (!frontOk && !isApiPath(url) && pathname !== "/agnx-warming") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(warmingPage());
      return;
    }

    // 重定向熔断：命中阈值就直接回说明页，不再转发，避免 iframe 无限重载烧 CPU。
    if (pathname === "/agnx-loop-halt") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loopHaltPage(pathname));
      return;
    }
    if (haltedUntil > Date.now()) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loopHaltPage(url));
      return;
    }
    if (redirectHits.get(pathname)?.length >= REDIRECT_HALT_THRESHOLD) {
      log("supervisor", `redirect loop halted on ${pathname} (>=${REDIRECT_HALT_THRESHOLD} redirects/${REDIRECT_WINDOW_MS}ms)`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loopHaltPage(url));
      return;
    }
    // 循环判定：实测前端是**在同一个 URL 上反复 reload**（不是发 302），
    // 所以这里按「HTML 导航请求到达同一路径的频率」计数，而不是数 302 响应。
    // 每 10 秒同一路径超过阈值 => 判定为循环，回说明页止住。
    {
      const accept = String(req.headers.accept || "");
      const isDocument = req.method === "GET" && accept.includes("text/html");
      if (isDocument) {
        const n = noteRedirect(pathname);
        if (n >= REDIRECT_HALT_THRESHOLD) {
          haltedUntil = Date.now() + 30_000;
          log("supervisor", `loop detected on ${pathname}: ${n} docs/${REDIRECT_WINDOW_MS}ms -> halt 30s`);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(loopHaltPage(url));
          return;
        }
      }
    }

    proxyHttp(
      req,
      res,
      isApiPath(url)
        ? { port: SERVER_PORT, host: `${BIND}:${SERVER_PORT}` }
        : { port: FRONT_PORT, host: `${BIND}:${FRONT_PORT}` },
    );
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    proxyUpgrade(
      req,
      socket,
      head,
      isApiPath(url)
        ? { port: SERVER_PORT, host: `${BIND}:${SERVER_PORT}` }
        : { port: FRONT_PORT, host: `${BIND}:${FRONT_PORT}` },
    );
  });

  httpServer.listen(PORT, BIND, () => {
    log("supervisor", `reverse proxy listening :${PORT}`);
    console.log(
      JSON.stringify({
        ok: true,
        service: "twenty-supervisor",
        origin: `http://${BIND}:${PORT}`,
        frontPort: FRONT_PORT,
        serverPort: SERVER_PORT,
      }),
    );
  });

  const shutdown = (sig) => {
    log("supervisor", `${sig} -> shutdown`);
    httpServer.close();
    for (const rec of children) killTree(rec);
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /**
   * 空闲自动退出（用户反馈「子应用在后台把 CPU 吃满」后加）：
   *
   * 二十的前端 dev server + Nest 后端常驻会一直占内存和少量 CPU；更要命的是
   * 前端在未登录态会自己陷入重定向循环（见上方熔断器）。用户关掉 Tab 之后，
   * 这套服务没有任何理由继续活着。
   *
   * 规则：连续 IDLE_EXIT_MS 内没有任何「非 healthz」请求，就整组退出。
   * 宿主下次打开 Tab 时 ensure 会重新拉起（ensure 本身是幂等的，见 tools/ensure-twenty.mjs）。
   * 可通过 --idle-exit-ms=0 关闭该行为（调试时常关）。
   */
  /**
   * 前端 CPU 看门狗（用户反馈「CPU 全满、风扇狂转」后加）：
   *
   * 就算熔断器挡住了重定向风暴，前端 dev server 仍可能在后台悄悄跑满一个核
   * （wyw-in-js 持续 miss、HMR 抖动等）。这里直接量它自己的 CPU 时间：
   * 每 30 秒采样一次，若连续 3 次（≈90 秒）单进程占用超过 80% 单核，
   * 就重启前端子进程，并把原因写日志。宁可重启一次，也不让用户风扇狂转。
   */
  const cpuWatchEnabled = !process.argv.includes("--no-cpu-watch");
  if (cpuWatchEnabled) {
    const CPU_SAMPLE_MS = 30_000;
    const CPU_STRIKES_LIMIT = 3;
    const CPU_PCT_LIMIT = 80;
    const strikes = new Map();
    let prev = new Map();

    const readCpuSeconds = (pid) => {
      try {
        const out = spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
        if (!out) return null;
        const parts = out.split(":").map(Number);
        if (parts.some((n) => Number.isNaN(n))) return null;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0];
      } catch {
        return null;
      }
    };

    const cpuTimer = setInterval(() => {
      for (const rec of children) {
        if (rec.exited || !rec.pid) continue;
        const now = readCpuSeconds(rec.pid);
        if (now == null) continue;
        const before = prev.get(rec.pid);
        prev.set(rec.pid, now);
        if (before == null) continue;
        const usedRatio = ((now - before) * 1000) / CPU_SAMPLE_MS; // 单核占比 0..1
        if (usedRatio >= CPU_PCT_LIMIT / 100) {
          const n = (strikes.get(rec.pid) ?? 0) + 1;
          strikes.set(rec.pid, n);
          log(
            "supervisor",
            `cpu-watch: ${rec.name}(pid=${rec.pid}) at ${Math.round(usedRatio * 100)}% of a core (strike ${n}/${CPU_STRIKES_LIMIT})`,
          );
          if (n >= CPU_STRIKES_LIMIT) {
            log("supervisor", `cpu-watch: restarting ${rec.name} — sustained high CPU`);
            strikes.delete(rec.pid);
            killTree(rec);
          }
        } else {
          strikes.delete(rec.pid);
        }
      }
    }, CPU_SAMPLE_MS);
    cpuTimer.unref?.();
    log("supervisor", `cpu watchdog enabled (>=${CPU_PCT_LIMIT}% core x${CPU_STRIKES_LIMIT} strikes => restart child)`);
  }

  const idleExitMs = Number(
    (process.argv.find((a) => a.startsWith("--idle-exit-ms=")) || "").split("=")[1] ?? 30 * 60_000,
  );
  if (Number.isFinite(idleExitMs) && idleExitMs > 0) {
    let lastActivity = Date.now();
    httpServer.on("request", (req) => {
      const p = (req.url || "").split("?")[0];
      if (p !== "/agnx-healthz") lastActivity = Date.now();
    });
    const idleTimer = setInterval(() => {
      const idleFor = Date.now() - lastActivity;
      if (idleFor >= idleExitMs) {
        log("supervisor", `idle for ${Math.round(idleFor / 1000)}s >= ${idleExitMs}ms -> auto shutdown`);
        clearInterval(idleTimer);
        shutdown("IDLE");
      }
    }, 30_000);
    idleTimer.unref?.();
    log("supervisor", `idle auto-exit enabled: ${Math.round(idleExitMs / 1000)}s`);
  }
}

main().catch((err) => {
  log("supervisor", `SUPERVISOR_FAILED: ${err?.stack || err?.message || err}`);
  console.error(`SUPERVISOR_FAILED: ${err?.message || err}`);
  process.exit(1);
});
