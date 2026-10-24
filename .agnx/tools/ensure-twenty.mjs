#!/usr/bin/env node
/**
 * 场景：Agnx 子应用 twenty 的受管 sidecar 启动脚本。
 *
 * 用法：node .agnx/tools/ensure-twenty.mjs --port 8132 --work-dir <dataRoot> [--supervised]
 * 输出（stdout 最后一行 JSON）：
 *   - 已就绪复用：{"ok":true,"reused":true,"origin":"http://localhost:8132","pid":N}
 *   - 需拉起：    {"ok":true,"reused":false,"plan":{command,args,cwd,env,fingerprint,healthUrl,port}}
 *   - 失败：      {"ok":false,"error":"<人话原因>"}
 *
 * 实际的「上游全套」由 .agnx/tools/supervisor.mjs 承载（反代 8132 → Vite 8136 → NestJS 8137）。
 * 本脚本只负责：环境变量注入、依赖守卫、复用探测、写宿主侧栏绿点需要的状态文件。
 *
 * 关键环境变量（全部是上游自己读的，零代码改动；依据 packages/twenty-server/.env.example）：
 *   PG_DATABASE_URL  → 本机 Postgres 的独立库 agnx_twenty（绝不碰已有库）
 *   REDIS_URL        → 复用本机 redis 6379
 *   PORT / SERVER_URL / FRONTEND_URL → 端口与同源地址
 *   APP_SECRET       → 上游必填，这里在数据根生成并持久化（同一实例复用）
 * 未设置 CLICKHOUSE_URL：上游是可选依赖（client-config 里 isClickHouseConfigured=false），
 * 不设则审计日志等特性优雅降级，不影响主界面与 CRM 主路径。
 */
import { spawn } from "node:child_process";
import { access, constants as fsConstants, mkdir, readFile, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "../..");
const APP_ID = "twenty";
const STATE_FILE = "twenty.json";
const DEFAULT_PORT = 8132;
const FRONT_PORT = 8136;
const SERVER_PORT = 8137;

/** 本机 Postgres：5432（pg 16.14，apple 用户可连）。库名独立，绝不动已有库。 */
const PG_DATABASE_URL =
  process.env.TWENTY_PG_DATABASE_URL ?? "postgres://apple@127.0.0.1:5432/agnx_twenty";
const REDIS_URL = process.env.TWENTY_REDIS_URL ?? "redis://127.0.0.1:6379";

/**
 * 上游 engines 要求 node ^24.5.0（根 package.json 与每个 packages 子包的 package.json 都写明）。
 * 本机 nvm 里装了 v24.21.0；这里不依赖当前 shell 的 node，直接取该绝对路径。
 * 找不到就显式报 NODE24_MISSING，不静默用 v22 硬撑（v22 下上游依赖可能装不上/跑不起来）。
 */
const NODE24_CANDIDATES = [
  process.env.TWENTY_NODE_BIN,
  "/Users/apple/.nvm/versions/node/v24.21.0/bin/node",
].filter(Boolean);

function parseArgs(argv) {
  const out = {
    port: Number(process.env.TWENTY_PORT ?? DEFAULT_PORT),
    workDir: process.env.AGNX_APP_DATA_ROOT || "",
    supervised: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.port = n;
      i += 1;
    } else if ((arg === "--work-dir" || arg === "--workDir") && next) {
      out.workDir = String(next).trim();
      i += 1;
    } else if (arg === "--supervised") {
      out.supervised = true;
    }
  }
  return out;
}

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function statePath(workDir) {
  return path.join(workDir, STATE_FILE);
}

async function readState(workDir) {
  try {
    return JSON.parse(await readFile(statePath(workDir), "utf8"));
  } catch {
    return null;
  }
}

function probe(url, timeoutMs = 2000) {
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

/** 数据根：宿主注入 --work-dir；缺失就显式报错，绝不能瞎写到 repo 里。 */
function resolveWorkDir(args) {
  if (!args.workDir) return null;
  return path.resolve(args.workDir);
}

/** APP_SECRET 上游必填；首次生成后持久化在数据根，重启复用（避免每次换密钥让会话失效）。 */
async function ensureAppSecret(workDir) {
  const p = path.join(workDir, "app-secret.txt");
  if (existsSync(p)) {
    const v = (await readFile(p, "utf8")).trim();
    if (v.length > 0) return v;
  }
  const v = randomBytes(32).toString("hex");
  await writeFile(p, v, "utf8");
  return v;
}

function buildEnv({ port, appSecret }) {
  const node24 = NODE24_CANDIDATES.find((p) => existsSync(p)) ?? process.execPath;
  const node24Dir = path.dirname(node24);
  return {
    PATH: `${node24Dir}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    NODE_ENV: "development",
    NODE_OPTIONS: "--max-old-space-size=8192",
    BROWSER: "none",

    // —— 数据库：本机 Postgres 独立库 agnx_twenty ——
    PG_DATABASE_URL,
    // —— 缓存/队列：复用本机 redis 6379 ——
    REDIS_URL,
    APP_SECRET: appSecret,

    // —— 端口与同源地址 ——
    //
    // ⚠️ 全部指向反代端口 8132（不是为了好看，是必须）。
    //
    // 踩过的坑：原来 SERVER_URL/REACT_APP_SERVER_BASE_URL 写成 :8137（后端真实端口），
    // 结果前端所有 GraphQL 请求都被打上 `Origin: http://127.0.0.1:8137`，
    // 后端对「带 session cookie 的请求」做同源校验，直接 403：
    //   {"error":"CSRF_ORIGIN_MISMATCH",
    //    "messages":["Request origin is not allowed for cookie-authenticated requests"]}
    // 表现就是：登录接口返回成功、但下一跳拿不到用户，页面永远停在欢迎页。
    // 只有让「页面来源」和「API 地址」都是 8132，才算真正同源。
    NODE_PORT: String(SERVER_PORT),
    PORT: String(SERVER_PORT),
    SERVER_URL: `http://localhost:${port}`,
    FRONTEND_URL: `http://localhost:${port}`,
    TWENTY_PORT: String(port),
    TWENTY_FRONT_PORT: String(FRONT_PORT),
    TWENTY_SERVER_PORT: String(SERVER_PORT),
    REACT_APP_PORT: String(FRONT_PORT),
    REACT_APP_SERVER_BASE_URL: `http://localhost:${port}`,

    // —— 本地单机：允许任意 workspace 创建、登录不走邮件验证 ——
    IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS: "false",
    // ⚠️ 必须是 false（2026-10-23 用户反馈「Tab 一直闪」后修正）。
    //
    // 实测链条：设成 true 时，前端 useReadDefaultDomainFromConfiguration 会把默认域名
    // 拼成 `${DEFAULT_SUBDOMAIN}.${frontDomain}` = `app.127.0.0.1`；
    // 而 useRedirectToDefaultDomain 只要发现 `window.location.hostname !== defaultDomain`
    // 就跳转到那个拼出来的域名 —— 本机没有该子域名的解析，加载失败 → 再跳 → 无限循环。
    // 表现就是宿主 Tab「一直闪」+ Electron 渲染进程吃满 CPU。
    // 设成 false 后 defaultDomain 就等于 frontDomain（127.0.0.1），与当前 hostname 一致，不再跳转。
    IS_MULTIWORKSPACE_ENABLED: "false",
    SIGN_IN_PREFILLED: "true",
    // 无 CLICKHOUSE_URL → 审计日志等特性自动降级（上游 isClickHouseConfigured=false）
  };
}

function fingerprintOf(port, workDir) {
  return createHash("sha256").update(`${APP_ID}:${port}:${workDir}`).digest("hex").slice(0, 16);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port;
  // ⚠️ 必须是 localhost，不能是 127.0.0.1。
  // 这个 origin 会被宿主直接当成 iframe 的 src，值与 Agnx 宿主（localhost:8083）
  // 不同 site 时，session cookie 会被浏览器按跨站策略丢弃，导致登录「假成功」。
  const origin = `http://localhost:${port}`;
  const healthUrl = `${origin}/agnx-healthz`;

  const workDir = resolveWorkDir(args);
  if (!workDir) {
    console.error("ENSURE_MISSING_DATA_ROOT: 需要 --work-dir 或 AGNX_APP_DATA_ROOT");
    process.exit(2);
  }
  await mkdir(workDir, { recursive: true });

  // 1) 端口已就绪 → 复用（关 Tab 再开不该重复起服务）
  const hit = await probe(healthUrl);
  if (hit.ok && hit.status === 200 && hit.body.includes("twenty-supervisor")) {
    const state = await readState(workDir);
    console.log(JSON.stringify({ ok: true, reused: true, origin, pid: state?.pid ?? null, port }));
    return;
  }
  if (hit.ok && hit.status > 0) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `PORT_IN_USE: :${port} 已被非 Twenty 服务占用（HTTP ${hit.status}）`,
      }),
    );
    return;
  }

  // 2) 依赖守卫：缺 node24 / node_modules / supervisor 时给人话，不静默失败
  const node24 = NODE24_CANDIDATES.find((p) => existsSync(p));
  if (!node24) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `NODE24_MISSING: 上游 engines 要求 node ^24.5.0，未找到 ${NODE24_CANDIDATES.join(" 或 ")}。请先 nvm install 24`,
      }),
    );
    return;
  }
  const upstream = path.join(appRoot, "upstream");
  if (!(await exists(path.join(upstream, "node_modules")))) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `UPSTREAM_DEPS_MISSING: ${upstream}/node_modules 不存在。请先 (cd ${upstream} && yarn install)`,
      }),
    );
    return;
  }
  const supervisor = path.join(appRoot, ".agnx", "tools", "supervisor.mjs");
  if (!(await exists(supervisor))) {
    console.log(JSON.stringify({ ok: false, error: `SUPERVISOR_MISSING: ${supervisor}` }));
    return;
  }

  const appSecret = await ensureAppSecret(workDir);
  const env = buildEnv({ port, appSecret });
  const fingerprint = fingerprintOf(port, workDir);
  const runtimeLog = path.join(appRoot, "logs", `${APP_ID}.log`);

  const plan = {
    command: node24,
    args: [
      supervisor,
      "--port",
      String(port),
      "--front-port",
      String(FRONT_PORT),
      "--server-port",
      String(SERVER_PORT),
      "--root",
      appRoot,
      "--data-root",
      workDir,
    ],
    cwd: appRoot,
    env,
    fingerprint,
    healthUrl,
    port,
    logFile: runtimeLog,
  };

  if (args.supervised) {
    // 只输出 plan，交给宿主 daemon supervisor 拉起（它负责 pid / 日志 / 退出清理）
    console.log(JSON.stringify({ ok: true, reused: false, plan }));
    return;
  }

  // 3) 非 supervised：自己 spawn 并等就绪（手工调试用）
  await mkdir(path.dirname(runtimeLog), { recursive: true });
  const out = openSync(runtimeLog, "a");
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const r = await probe(healthUrl);
    if (r.ok && r.status === 200 && r.body.includes("twenty-supervisor")) {
      await writeFile(
        statePath(workDir),
        JSON.stringify({ appId: APP_ID, port, pid: child.pid, origin, fingerprint, logFile: runtimeLog }, null, 2),
        "utf8",
      );
      console.log(JSON.stringify({ ok: true, reused: false, origin, pid: child.pid, port }));
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  console.log(JSON.stringify({ ok: false, error: `START_TIMEOUT: 45 分钟内未就绪，见 ${runtimeLog}` }));
}

main().catch((err) => {
  console.error(`ENSURE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
