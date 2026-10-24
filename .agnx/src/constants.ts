/**
 * 场景：Twenty CRM 子应用常量。appId / panelId / 端口 / ensure 路径的唯一出处。
 *
 * 端口分工（硬约束，见 EMBED.md 第二节）：
 * - 8132：Tab 挂载的主入口（Agnx 反代；对外唯一可见端口，manifest.sidecar.defaultPort）
 * - 8136：上游 Vite dev server（前端 + /graphql 等 API 反向代理到 8137）
 * - 8137：上游 NestJS 后端（twenty-server）
 * 8132 为批次台账独占分配；8136 与 8137 必须写进 manifest.sidecar.extraPorts，
 * 否则宿主停服务 / 清场时看不到它们，残留进程会一直占着。
 */
export const TWENTY_APP_ID = "twenty";
export const TWENTY_PANEL_ID = "twenty.main";
export const TWENTY_OPEN_COMMAND_ID = "twenty.open";
export const TWENTY_ENSURE_TOOL_REL = ".agnx/tools/ensure-twenty.mjs";

/** 主入口端口：Agnx 反代（proxied-iframe 的 origin）。 */
export const TWENTY_DEFAULT_PORT = 8132;
/** 上游 Vite dev server 端口（前端 + API 代理）。 */
export const TWENTY_FRONT_PORT = 8136;
/** 上游 NestJS 后端端口。 */
export const TWENTY_SERVER_PORT = 8137;
