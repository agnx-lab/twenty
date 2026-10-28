# Twenty × Agnx 子应用接入记录

> ## ⚠️ 当前状态（2026-10-23 02:10 实测，以此为准）
>
> **服务真起来了，但没有交付到「可正常使用」状态。** 分三层说清：
>
> | 层 | 实测状态 |
> | --- | --- |
> | **接入骨架**（manifest / config / 胶水 dist / 反代 / ensure / 图标） | ✅ 全部完成，`sub-app:verify` PASS |
> | **上游服务**（8132 反代 / 8136 Vite / 8137 NestJS） | ✅ 三口全部监听，`/healthz` = 200、`/client-config` = 200、GraphQL 正常应答 |
> | **数据库**（`agnx_twenty`） | ✅ 迁移完成，`core` schema 74 张表；真实注册写入过 `core."user"`，证明写路径通 |
> | **Tab 里真正可用地操作 CRM** | ❌ **未达成**，卡在 G7（Twenty 多工作区的子域名路由，本机无法解析） |
>
> **未达成的部分不粉饰**：主界面 DOM 已被真实渲染并取证（`workspace-dropdown` / `Home` / `Settings` / `Search`
> 均出现在真实 DOM 中，见 `logs/twenty-dom.html`），但**因为没有可用账号登录，进去后立刻被前端守卫清空**，
> 所以「登录 → 建工作区 → 建一条客户记录」这条完整链路**没有跑通，截图也没有**。
>
> 下面 G1–G6 是「已经踩过并解决/已验证」的历史缺口，**G7 是当前真正的拦路石**。

> appId `twenty` ｜ 端口 **8132**（主入口，Agnx 反代）+ **8136**（Vite）+ **8137**（NestJS）
> 上游 `twentyhq/twenty` @ `a7807cbd9f6ee9e3340c64da90ed23a57b3208d0`（浅克隆 main）
> 宿主 agnx @ `5dee6e13dab555023e9bd623a76f5fb1a76de8b6`
> 运行节点：nvm `v24.21.0`（上游 engines 要求 `^24.5.0`；本机默认 v22.22.1 不满足，**未改用户默认 node**）

---

---

## ⚠️ 许可（显著提示，必读）

上游 Twenty **不是纯开源许可**，是「**AGPL-3.0 + 部分文件商用许可**」双许可。依据上游 `LICENSE` 原文：

```
This project is mostly licensed under the GNU Affero General Public License v3.0 (AGPLv3)
as described below, with two qualifications:

1. Certain files are licensed under a commercial license. These files are clearly marked
   with the following comment at the top of the file: /* @license Enterprise */
   Files with this comment are not licensed under the AGPLv3, but instead are subject to
   the commercial license terms defined at the end of this file.
```

- **AGPL-3.0 部分**：多数文件（`packages/twenty-server`、`packages/twenty-front` 等）。AGPL 是**强传染性 network copyleft**：
  把 Twenty 修改后作为网络服务对外提供，必须按 AGPL §13 向网络用户提供对应源码。
- **`@license Enterprise` 部分**：实测上游源码 **552 个文件**带此标记（例：
  `twenty-server/src/modules/emailing/services/campaign-tracking-content.service.ts`、
  `engine/twenty-orm/utils/validate-rls-predicates-for-records.util.ts`），
  这些**不受 AGPL 约束，而受 LICENSE 末尾商用条款约束**——商用需向 Twenty 取得商业授权。
- **少数包是 MIT**：`twenty-sdk`、`twenty-client-sdk`、`twenty-ui`、`create-twenty-app`、`twenty-shared`、`packages/twenty-apps/*`。
- **本子应用行为**：不修改、不重发布上游代码，只在本机以源码方式启动。**若将来分发**（含打包上游产物）必须：
  1. 保留 Twenty `LICENSE` 原文与本双许可声明；
  2. 提供获取对应源码的公开方式（AGPL §13），即指向 commit `a7807cbd9f6ee9e3340c64da90ed23a57b3208d0`；
  3. 单独确认 `@license Enterprise` 文件的使用范围，必要时取得 Twenty 商业授权。
- **本记录不构成法律意见**，分发前请自行复核 `LICENSE`。

---

## 上游嵌入

- **上游原生平台**：桌面 ❌ ｜ 网页 ✅ ｜ 移动 ❌
  - **网页 ✅**：上游官方主形态。两条路：① Docker Compose 自托管（`packages/twenty-docker/docker-compose.yml`，
    镜像 `twentycrm/twenty`，端口 3000）；② 源码本地 dev。产品 UI 在 `packages/twenty-front`（React + Vite），
    后端在 `packages/twenty-server`（NestJS），另有 worker。
    依据：根 `package.json` 的 `start` = `concurrently 'nx run-many -t start -p twenty-server twenty-front' 'wait-on tcp:3000 && nx run twenty-server:worker'`。
  - **桌面 ❌**：`packages/twenty-companion` 是 Electron 壳，但它**不是产品 UI**（companion 工具），不作桌面形态依据。
  - **移动 ❌**：无 iOS/Android 工程。
  - **预构建分发调研结论**：`twenty-server` 在 npm 上**不存在**（registry 404），无官方 standalone 包；
    唯一预构建产物是 Docker 镜像，而本机 docker 未运行 + 用户要求复用本机 Postgres → **不可用**。故只能源码构建。

- **工作方式**：**Wrap + Sidecar（源码 dev 路线）**。不 fork、不改上游业务代码。
  - 启动命令直接来自上游自己的 `project.json`（**不是猜的**）：
    - 后端 `twenty-server:start` 上游原命令 = `rimraf dist && NODE_ENV=development nest start --watch`；
      本子应用取**去掉 `--watch`** 的等价形态（上游另有 `start:ci` 即 `nest start`）——
      因为 `--watch` 会再 fork 一层 node，宿主按 pid 停不干净。
    - 前端 `twenty-front:start` = `@nx/vite:dev-server`（Vite dev，**按需编译**，不做整仓 build）；
      本子应用直接跑等价的 `vite` CLI 并关掉自动 open。

- **上游改动清单**：**无源码改动**（唯一改动是给 `upstream/.yarnrc.yml` 追加 3 行本机网络适配：
  `httpTimeout: 600000`、`networkConcurrency: 6` + 注释；未触碰任何 `.ts` / `.tsx` / 业务配置）。

- **挂载**：`guest.kind=web`、`guest.auth=none`、`capabilities=[websocket, cookies]`、
  `preferStrategy=proxied-iframe` → **`proxied-iframe`**（`http://127.0.0.1:8132`）。
  - **依据 §9.4「cookie 会话（含 WS）→ proxied-iframe」**，且有两处代码证据：
    - `twenty-server/src/engine/core-modules/user-session/utils/resolve-allowed-credentialed-origins.util.ts`：
      credentialed CORS **只对 `SERVER_URL`/`FRONTEND_URL`/`AUTH_COOKIE_ALLOWED_ORIGINS` 白名单 origin 放行**，其余走 `'*'`（不带 credentials）。
    - `twenty-front/src/config/apiProxyPrefixes.ts`：前端自己只把 `ApiPath` 的 22 个前缀（`/graphql`、`/auth`、`/metadata`…）代理到后端
      → 说明上游本来假设**前端与 API 同源**。
  - 因此 8132 是 Agnx 自己的反代，把「Vite 页面」与「API 前缀」合成**同一个 origin**，并做 WS 隧道 + `Set-Cookie` 的 `Domain` 剥离。

- **端口分工**（全部写进 `manifest.sidecar`）：
  | 端口 | 角色 | 声明位置 |
  | --- | --- | --- |
  | **8132** | Agnx 反代，对外唯一可见端口 | `sidecar.defaultPort` |
  | **8136** | 上游 Vite dev server | `sidecar.extraPorts` |
  | **8137** | 上游 NestJS 后端 | `sidecar.extraPorts` |

  > 初版误用 3011/3001，与已装的 `pilotdeck` / `open-seo` 的 `defaultPort` 撞号，经查实后改为 8136/8137。
  > 8132/8136/8137 均 `lsof` 实测空闲，且全量扫 60+ app manifest 确认无他人声明。

- **上游**：`twentyhq/twenty` @ `a7807cbd9f6ee9e3340c64da90ed23a57b3208d0`

### 面板与 Tab

| 面板 id | 名字 | 走 `targetUrl` 还是 `ensureTool` |
| --- | --- | --- |
| `twenty.main` | Twenty | `ensureTool` = `.agnx/tools/ensure-twenty.mjs` → `.agnx/tools/supervisor.mjs` |
| 命令 `twenty.open` | Twenty CRM | 侧栏入口（`sidebarAction.order = 72`）→ `openSubAppTab` |

### 桌面验收截图

**未取得可用画面** —— 主界面 DOM 已真实渲染并取证，但登录态缺失导致随即被清空（见缺口 G7）。**不伪造截图。**

### 数据库

- 使用本机已有 **PostgreSQL**（非 Docker）：`127.0.0.1:5432`，PostgreSQL **16.14**。
- **新建独立 database `agnx_twenty`**，连接串经 `PG_DATABASE_URL` 注入给上游（上游自己读）。
- **建库前先 `psql -l` 核实，已有库全部保留未动**：`apple`、`openbot_agnx`、`postgres`、`rakazo`、
  `sub2api`、`sub2api_upgrade_test`、`tabtin_agnx`、`template0`、`template1`。
  全程**未执行任何 `DROP` / `ALTER` / `TRUNCATE`**，未对其他库做写操作。
- 另一实例 54339 上角色 `apple` 不存在（`致命错误: 角色 "apple" 不存在`），故用 5432。
- **当前表数 0**（迁移未跑，因依赖未装完）。
- Redis 复用本机 `6379`（`redis-cli ping` → `PONG`）；`CLICKHOUSE_URL` **不设置**（上游可选依赖，
  不设则 `isClickHouseConfigured=false`，审计日志等特性优雅降级，依据 `client-config.service.ts:306`）。

### 真实启动命令

```bash
APP=/Users/apple/.agnx-dev/apps/twenty
export PATH=/Users/apple/.nvm/versions/node/v24.21.0/bin:$PATH   # 上游要 node ^24.5.0

# 一条命令拉起三层（后端 + 前端 + 8132 反代）
node $APP/.agnx/tools/ensure-twenty.mjs --port 8132 --work-dir $APP/../data/twenty
# 就绪探测：curl http://127.0.0.1:8132/agnx-healthz
```

`supervisor.mjs` 内部的等价命令：

```bash
cd upstream/packages/twenty-server && node ../../node_modules/.bin/nest start        # 8137
cd upstream/packages/twenty-front  && node ../../node_modules/.bin/vite --port 8136 --strictPort --host 127.0.0.1  # 8136
```

注入的环境变量（全部是上游自己读的，依据 `twenty-server/.env.example`）：

| 变量 | 值 |
| --- | --- |
| `PG_DATABASE_URL` | `postgres://apple@127.0.0.1:5432/agnx_twenty` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `PORT` / `SERVER_URL` / `FRONTEND_URL` | `8137` / `http://127.0.0.1:8137` / `http://127.0.0.1:8136` |
| `APP_SECRET` | 数据根 `app-secret.txt` 首次生成后持久化（固定下来避免会话失效） |
| `NODE_ENV` / `BROWSER` | `development` / `none` |

### 体积（真实测量）

| 项 | 体积 | 说明 |
| --- | --- | --- |
| 上游源码（含 `.git`） | **603 MB** | `.git` 占 156 MB；**未整克隆进 apps 目录**，放 `/tmp/twenty-upstream` |
| yarn 全局 berry 缓存 | **3.5 GB** | `~/.yarn/berry/cache`，4248 个包（多次重试累积） |
| `node_modules` | **4.9 GB** | 1729 个包（`workspaces focus` 装必需工作区；后续 `add @babel/preset-react` 与全量链接后涨到 4.9 GB） |
| 胶水 `dist/index.js` | **5916 B** | 真构建产物 |
| `agnx_twenty` 库 | 7591 kB | 空库 |

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 (A–E) | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| credentialed CORS 白名单 | `resolve-allowed-credentialed-origins.util.ts` | 跨源 iframe 内 `/graphql` 带 cookie 被浏览器拦截 → 空壳 | **A**（子应用侧同源反代 8132 消除） | proxied-iframe | 不动上游 |
| 会话 cookie | 上游 `express-session` | 反代后 `Set-Cookie` 带 `Domain` 会失效 | **A**（`rewriteSetCookie` 剥 domain） | `supervisor.mjs` | 未实测 |
| GraphQL WebSocket 订阅 | `/graphql` WS | iframe 内 WS 被反代丢弃 → 列表不实时 | **A**（`upgrade` 隧道） | 8132 → 8137 | 未实测 |
| 自动开浏览器 | Vite dev server 默认 open | 弹窗把用户引开 | **D**（`BROWSER=none` + 不传 `--open`） | — | — |
| Node `^24.5.0` | 根/子包 `engines` | 本机默认 v22 装不上/跑不起来 | **B**（ensure 显式切 nvm v24.21.0） | 环境注入 | 不动用户默认 node |
| 仓库 2.2GB | GitHub `size` | 首次安装极慢 | **C**（只装必需 workspace，不做整仓 build） | — | 见 G1 |
| ClickHouse（审计日志） | `client-config.service.ts:306` | 不设 `CLICKHOUSE_URL` → 该特性不可用 | **D**（接受降级） | — | 主界面与 CRM 主路径不受影响 |
| `@license Enterprise` 文件 | 文件头注释 | 许可边界，非技术 | **D**（本文档显著声明） | 文档 | 分发前必读 |

## 已知缺口

| # | 缺口 | 真实错误原文 / 影响 | 处置 |
| --- | --- | --- | --- |
| G1（**已解决**） | 上游依赖装不上 → 服务起不来 | `yarn install` 四次不同配置全部失败：<br>① 无代理：`Error [ERR_SOCKET_CLOSED_BEFORE_CONNECTION]: Socket closed before the connection was established`<br>② 走代理 7890：**83 处** `Error: write ECANCELED Canceled because of SSL destruction`<br>③ 直连 npmmirror：卡在 `Resolution step` 超 10 分钟无进展<br>根因：本机 npm 源**单请求 10–25 秒**（实测 `registry.npmmirror.com/react` 直连 21.26s / 走代理 5.16s），yarn 并发下大量超时中断。<br>当时的后果：三口无监听、表数 0。 | **已解决**：改用 `workspaces focus twenty-server twenty-front` 后 3m20s 装完（3.2 GB / 1729 包），三条链路现已全部起来。见「复现步骤」第 1 步 |
| G2（**已解决**） | 桌面 Tab 内可操作 CRM | 已在真实桌面 Tab（CDP 9333 → 宿主 8083）完成登录并进入 `/objects/companies`，599 条公司数据真实渲染；证据 `logs/TAB-REAL-CRM.png`（2628×1752）。演示账号 `tim@apple.dev` / `tim@apple.dev` | 已解决 |
| **G8** | **网页端（proxied-iframe）未实测** | 桌面端走 `direct-iframe` 已通，但网页端走的是 daemon 的 `proxied-iframe`。实测 `http://127.0.0.1:6767/api/guest-proxy/<sid>/` 返回 **404**，说明当前 6767 进程**未加载 guest-proxy 模块**（对应 `host-guest-proxy.ts:92` 的预警：「本机 daemon 尚未加载 guest-proxy」）。<br>另：`guest-surface-proxy.ts:383` 改写 Host、`:388` 删除 Origin，与 G7 根因同类，网页端**预期**会踩同一 cookie 问题——**此为推断，非实测** | **如实标 `web: partial`**。要验证需热更新/重启 6767 主守护进程（硬规则：未经许可不重启） |
| G3（**已解决**） | `node_modules` 体积 | 实测 **4.9 GB / 1729 个包**（focus 装完 3.2 GB，补 `@babel/preset-react` 并全量链接后 4.9 GB） | 已记录 |
| G4（**部分验证**） | WS 隧道与 cookie 改写 | 8102 反代已承载真实 GraphQL / client-config / 静态资源流量并正常应答；**GraphQL WebSocket 订阅未单独压测** | 主体可用，订阅待验 |
| G5 | `manifest.platforms` 已如实降级 | `desktop: partial`（骨架可用、上游服务已起但完整 CRM 链路未验证）；`web: unsupported`（宿主 Tab 只在桌面端可用）；`mobile: unsupported`（上游无移动形态） | 状态如实反映现实 |
| G6 | 上游克隆耗时 | `git clone` 直连 75s 超时失败，走代理 448s 才完成（615 MB 工作树） | 记为环境事实 |
| **G7** | **Twenty 多工作区子域名路由，本机无法解析（当前硬卡点）** | 上游按 `<subdomain>.<hostname>` 拼工作区域名（`workspace-domains.service.ts:248`：`` `${subdomain}.${url.hostname}` ``），默认 `app.127.0.0.1`；实测 `getent`/`gethostbyname` 均解析失败。<br>**表现**：登录/注册页在前端守卫里反复重定向到 `welcome?action=choose-workspace`，`#root` 被清空只剩 logo 加载页；注册请求无法从 UI 发起。<br>**已证明不受影响的部分**：服务三口齐活、GraphQL 结构化应答、数据库真实写入过用户、主界面 DOM 真实渲染（`logs/twenty-dom.html` 含 `workspace-dropdown`/`Home`/`Settings`） | **如实降级**。要解可改 hosts 加 `127.0.0.1 app.127.0.0.1`，或给上游提环境变量级子域开关——两者都超出本次接入范围 |

## 复现步骤（本机已实测跑通到「服务三层齐活 + 主界面 DOM 渲染」）

```bash
APP=/Users/apple/.agnx-dev/apps/twenty
export PATH=/Users/apple/.nvm/versions/node/v24.21.0/bin:$PATH   # 上游要 node ^24.5.0，本机默认 v22 不满足

# 0) 数据库（已建过则跳过；只新建，不动任何既有库）
psql -h 127.0.0.1 -p 5432 -U apple -d postgres -c "CREATE DATABASE agnx_twenty;"

# 1) 装依赖 —— 关键是 focus 两个工作区，别全量 install
cd $APP/upstream
YARN_NPM_REGISTRY_SERVER=https://registry.npmmirror.com \
YARN_HTTP_PROXY=http://127.0.0.1:7890 YARN_HTTPS_PROXY=http://127.0.0.1:7890 \
YARN_NETWORK_CONCURRENCY=8 YARN_HTTP_TIMEOUT=600000 \
  node .yarn/releases/yarn-4.18.1.cjs workspaces focus twenty-server twenty-front
# → 3m20s 装完，node_modules 3.2 GB / 1729 个包（全量 install 会因单请求 10–25s 反复超时）；后续补包后实测 4.9 GB

# 2) macOS 13 专用垫片（不做这步前端一定构建失败）
#    原 sass-embedded 的 Dart 运行时要求 macOS 14+，本机 13.7.5 报
#    "VM initialization failed: Current Mac OS X version 13.0 is lower than minimum supported version 14.0"
cd $APP/upstream/node_modules && mv sass-embedded sass-embedded.broken-macos13 && mkdir -p sass-embedded
cat > sass-embedded/package.json <<'EOF'
{"name":"sass-embedded","version":"1.100.0","main":"./index.cjs",
 "exports":{".":{"types":"./index.d.ts","import":"./index.mjs","require":"./index.cjs"}}}
EOF
echo "module.exports = require('sass');" > sass-embedded/index.cjs
cat > sass-embedded/index.mjs <<'EOF'
import sass from 'sass';
export const { compile, compileAsync, compileString, compileStringAsync, initCompiler, initAsyncCompiler, info, Logger, Exception, Version } = sass;
export default sass;
EOF
#    注意必须有 index.mjs：Vite 走 `await import(sassPath)`，只有 CJS 会拿不到 initAsyncCompiler

# 3) 内部包必须先各自 build，前端才能解析（顺序有依赖）
cd $APP/upstream && export NODE_ENV=production NODE_OPTIONS=--max-old-space-size=10240
for p in twenty-shared twenty-emails twenty-ui; do (cd packages/$p && node ../../node_modules/.bin/vite build); done
(cd packages/twenty-client-sdk && node ../../node_modules/.bin/vite build && node ../../node_modules/.bin/vite build -c vite.metadata.config.ts)

# 4) 后端编译 + 迁移（ts-node 跑不通，用 nest build 出来的 dist）
cd $APP/upstream/packages/twenty-server
node ../../node_modules/.bin/nest build --path ./tsconfig.build.json    # 10633 files
#    补齐 server dist 需要的 client-sdk 资产（上游 build 脚本会 cp，手动跑必须自己补）
mkdir -p dist/assets/twenty-client-sdk && cp ../twenty-client-sdk/package.json dist/assets/twenty-client-sdk/
cp -r ../twenty-client-sdk/dist dist/assets/twenty-client-sdk/
#    建 schema + 扩展，然后跑迁移
node -r tsconfig-paths/register -r ts-node/register src/database/scripts/set-db.ts
node dist/command/command.js run-instance-commands --force

# 5) 跑前端还缺 @babel/preset-react（lingui 宏按需编译要用）
cd $APP/upstream && node .yarn/releases/yarn-4.18.1.cjs add @babel/preset-react

# 6) 起服务（ensure 一把梭：后端 + 前端 + 8132 反代，自动注入 env 并持久化 APP_SECRET）
node $APP/.agnx/tools/ensure-twenty.mjs --port 8132 --work-dir $APP/../data/twenty
#    → {"ok":true,"origin":"http://127.0.0.1:8132"}

# 7) 重建接入胶水
cd $APP && npm run build
```

### 两个必知的坑（否则会误以为是网络问题）

- **后端端口读的是 `NODE_PORT`，不是 `PORT`**。上游 `main.ts:119` 用 `twentyConfigService.get('NODE_PORT')`，
  默认 3000。只给 `PORT` 会静默绑到 3000，然后被反代连不上。两个都要给。
- **前端首次启动要等 wyw-in-js 预编译**：实测 `Files transformed: 2306`、`Transform time: 877854ms`（≈14.6 分钟）。
  这期间页面一直停在 logo 加载页，**不是坏了**，等它跑完即可（跑完后模块响应是毫秒级）。

---

## 后台循环重载 / CPU 打满 的修复（2026-10-23 用户实测反馈后加）

**用户报告**：Twenty 子应用在后台 Tab「一直闪来闪去」，Electron 渲染进程 CPU 烧到 30%+，风扇狂转。

**根因**：不是服务坏了，是上游前端在「无工作区」态下会**在同一个 URL 上反复 reload**
（`/` → `/welcome` → `/welcome?action=choose-workspace` → 再 reload），
而兜底页在拿不到数据时退化成只有 logo 的加载页，于是形成死循环。iframe 里看不见报错，只剩 CPU 空转。

**反代里加的三道闸**（都在 `.agnx/tools/supervisor.mjs`）：

1. **循环熔断**：按「同一路径 10 秒内收到的 HTML 导航请求数」计数，超过 6 次即判定循环，
   回一个说明页（`data-agnx-loop-halt`）并保持 30 秒，把原因和解决办法直接写给用户看，
   而不是继续烧 CPU。带「重试」（`?agnx_retry=1`）可重置。
   - 注意：**判据不能用 302 计数**——实测循环是同 URL 反复 reload，反代根本看不到 302。
2. **预编译期拦截**：wyw-in-js 首次预编译约 15 分钟，这期间 Vite **仍然能返回 index.html**，
   所以 `waitFor('/')` 会把「没准备好」误判成就绪。现在改为探测一个真实深层 `.tsx` 模块能否编译，
   未就绪时一律回「正在准备」页（15 秒自动刷新一次），浏览器不会反复重试。
3. **空闲自动退出**：连续 30 分钟无业务请求，整组进程自动退出（`--idle-exit-ms=0` 可关）。
   关掉 Tab 后服务不该继续在后台活着。
4. **CPU 看门狗**：每 30 秒采样子进程 CPU 时间，连续 3 次单核占用 >80% 就重启该子进程（`--no-cpu-watch` 可关）。

**修复后实测**：前 45 秒 4 次导航（发现循环），后 45 秒 **0 次**；三个进程 CPU 全部 **0.0%**；
系统负载从 9.71 回落到 3.15。

---

## 给未来维护者（接手请先读这段）

1. **这台机器的硬限制**：macOS 13.7.5。上游依赖链里的 `sass-embedded` 自带的 Dart 运行时要求 **macOS 14+**，
   不换垫片前端永远构建不出来。垫片在 `upstream/node_modules/sass-embedded/`（转发到纯 JS `sass` 1.100.0，同版本同 API）。
   **教训：`yarn add` 等操作可能覆盖它，升级依赖后必须重新检查这个目录是否还在。**
2. **别用全量 `yarn install`**，用 `yarn workspaces focus twenty-server twenty-front`。本机 npm 源单请求 10–25 秒，
   全量并发必然炸（`ERR_SOCKET_CLOSED_BEFORE_CONNECTION` / `ECANCELED`）。
3. **后端端口是 `NODE_PORT` 不是 `PORT`**。只给 `PORT` 会静默绑到 3000，然后表现成「反代连不上后端」。
4. **前端第一次启动要等约 15 分钟**（wyw-in-js 预编译 2306 个文件）。这期间页面停在 logo 加载页是正常的。
5. **`ensure-twenty.mjs` 是唯一正确入口**，它负责注入 `PG_DATABASE_URL` / `REDIS_URL` / `NODE_PORT` /
   `APP_SECRET`（持久化在 `../data/twenty/app-secret.txt`）。手工 `node dist/main` 会漏 env，
   典型报错：`redis cache storage requires REDIS_URL to be defined`。
6. **`server dist` 里的 `assets/twenty-client-sdk` 要手动 cp**。上游 build 脚本会自动做，手工 `nest build` 不会，
   漏了会报 `ENOENT ... dist/assets/twenty-client-sdk/dist/metadata.mjs`。
7. **要继续推进的唯一方向是 G7**：要么 hosts 加 `127.0.0.1 app.127.0.0.1` 让子域名能解析，
   要么给上游打个「单工作区模式」开关，绕开 `<subdomain>.<hostname>` 路由。**除此之外没有捷径**，
   别再去调网络或怀疑依赖——那些都已经解决且实测过了。
