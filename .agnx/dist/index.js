var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// .agnx/src/index.ts
var index_exports = {};
__export(index_exports, {
  activate: () => activate,
  appId: () => appId,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

// .agnx/src/constants.ts
var TWENTY_APP_ID = "twenty";
var TWENTY_PANEL_ID = "twenty.main";
var TWENTY_OPEN_COMMAND_ID = "twenty.open";
var TWENTY_ENSURE_TOOL_REL = ".agnx/tools/ensure-twenty.mjs";
var TWENTY_DEFAULT_PORT = 8132;

// .agnx/src/panel.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var WEB_ROOT_STYLE = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative"
};
var GUEST_HOST_STYLE = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative"
};
var LAYER = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9,9,11)"
};
var ERROR_TEXT_STYLE = {
  margin: "auto",
  maxWidth: 620,
  padding: 24,
  color: "rgb(248,113,113)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap"
};
var boundHost = null;
function bindTwentyHost(host2) {
  boundHost = host2;
}
function host() {
  if (!boundHost) throw new Error("Twenty host \u672A\u7ED1\u5B9A");
  return boundHost;
}
function TwentyPanel() {
  const guestHostRef = (0, import_react.useRef)(null);
  const [booting, setBooting] = (0, import_react.useState)(true);
  const [error, setError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    const h = host();
    h.background?.requestRetain?.({ appId: TWENTY_APP_ID, active: true, reason: "twenty-open" });
    return () => {
      h.background?.requestRetain?.({ appId: TWENTY_APP_ID, active: false, reason: "twenty-open" });
    };
  }, []);
  (0, import_react.useEffect)(() => {
    const h = host();
    if (!h.guest?.mount || !guestHostRef.current) {
      setBooting(false);
      setError("\u5BBF\u4E3B\u672A\u63D0\u4F9B host.guest.mount\uFF08\u9700\u5347\u7EA7 Agnx \u5E76\u91CD\u65B0\u626B\u63CF\u5B50\u5E94\u7528\uFF09");
      return;
    }
    let cancelled = false;
    const unmount = h.guest.mount({
      container: guestHostRef.current,
      ensureTool: TWENTY_ENSURE_TOOL_REL,
      ensureArgs: ["--port", String(TWENTY_DEFAULT_PORT)],
      // 上游 NestJS 首次启动要跑迁移 + 建 workspace 元数据，给足时间。
      timeoutMs: 6e5,
      surfaceReadyTimeoutMs: 18e4,
      bootOverlay: false,
      onReady: () => {
        if (cancelled) return;
        window.setTimeout(() => {
          if (!cancelled) setBooting(false);
        }, 600);
      },
      onError: (d) => {
        if (cancelled) return;
        setBooting(false);
        setError(`${d.code}: ${d.message}`);
      }
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);
  const BrandPanel = host().ui?.BrandLogoLoaderPanel;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: WEB_ROOT_STYLE, "data-testid": `workspace-mini-app-${TWENTY_APP_ID}-root`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: guestHostRef, "data-agnx-guest-surface-host": "true", style: GUEST_HOST_STYLE }),
    booting && !error && BrandPanel ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { "data-agnx-guest-boot-overlay": "true", style: LAYER, role: "status", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(BrandPanel, { title: "\u6B63\u5728\u542F\u52A8 Twenty\u2026", testID: "twenty-boot-overlay" }) }) : null,
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...LAYER, overflow: "auto" }, role: "alert", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: ERROR_TEXT_STYLE, children: error }) }) : null
  ] });
}

// .agnx/src/index.ts
var appId = TWENTY_APP_ID;
function activate(host2) {
  bindTwentyHost(host2);
  const disposers = [];
  disposers.push(
    host2.registerMiniApp({
      id: TWENTY_PANEL_ID,
      appId: TWENTY_APP_ID,
      title: "Twenty",
      component: TwentyPanel,
      primaryPanel: true,
      iframeShortcutCapture: true
    })
  );
  disposers.push(
    host2.registerCommand({
      id: TWENTY_OPEN_COMMAND_ID,
      appId: TWENTY_APP_ID,
      title: "Twenty CRM",
      keywords: ["twenty", "crm", "\u5BA2\u6237", "\u9500\u552E", "\u5546\u673A"],
      sidebarAction: { defaultVisible: true, label: "Twenty", order: 72 },
      run: (context) => {
        host2.openSubAppTab({
          appId: TWENTY_APP_ID,
          panelId: TWENTY_PANEL_ID,
          serverId: context?.serverId,
          workspaceId: context?.workspaceId,
          currentPathname: context?.currentPathname
        });
      }
    })
  );
  return () => {
    for (const d of disposers.toReversed()) d();
  };
}
var moduleExport = { appId: TWENTY_APP_ID, activate };
var index_default = moduleExport;
