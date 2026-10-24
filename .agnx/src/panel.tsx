/**
 * 场景：Twenty CRM 主面板 —— 满铺挂载 Guest 嵌入面（走 ensureTool sidecar，主入口端口 8132）。
 * 硬约束：根与 guest host 不允许 padding / margin；失败态才允许带 padding 的 fallback。
 *
 * 挂载策略 = proxied-iframe：8132 是 Agnx 自己的反代（22 Twenty 的 HTML + 代理 3011 上游），
 * 上游要 cookie 会话 + WebSocket 订阅，走 §9.4「cookie 会话（含 WS）→ proxied-iframe」。
 */
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactElement,
} from "react";
import type {
  WorkspaceAppBrandLogoLoaderPanelProps,
  WorkspaceAppHostApi,
} from "@agnx-lab/app-sdk";
import {
  TWENTY_APP_ID,
  TWENTY_DEFAULT_PORT,
  TWENTY_ENSURE_TOOL_REL,
} from "./constants";

const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};
const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};
const LAYER: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9,9,11)",
};
const ERROR_TEXT_STYLE: CSSProperties = {
  margin: "auto",
  maxWidth: 620,
  padding: 24,
  color: "rgb(248,113,113)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
};

let boundHost: WorkspaceAppHostApi | null = null;
export function bindTwentyHost(host: WorkspaceAppHostApi): void {
  boundHost = host;
}
function host(): WorkspaceAppHostApi {
  if (!boundHost) throw new Error("Twenty host 未绑定");
  return boundHost;
}

export function TwentyPanel(): ReactElement {
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  // 首帧即 true：在 await mount 之前盖住空 host，避免黑屏闪。
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = host();
    h.background?.requestRetain?.({ appId: TWENTY_APP_ID, active: true, reason: "twenty-open" });
    return () => {
      h.background?.requestRetain?.({ appId: TWENTY_APP_ID, active: false, reason: "twenty-open" });
    };
  }, []);

  useEffect(() => {
    const h = host();
    if (!h.guest?.mount || !guestHostRef.current) {
      setBooting(false);
      setError("宿主未提供 host.guest.mount（需升级 Agnx 并重新扫描子应用）");
      return;
    }
    let cancelled = false;
    const unmount = h.guest.mount({
      container: guestHostRef.current,
      ensureTool: TWENTY_ENSURE_TOOL_REL,
      ensureArgs: ["--port", String(TWENTY_DEFAULT_PORT)],
      // 上游 NestJS 首次启动要跑迁移 + 建 workspace 元数据，给足时间。
      timeoutMs: 600_000,
      surfaceReadyTimeoutMs: 180_000,
      bootOverlay: false,
      onReady: () => {
        if (cancelled) return;
        // 上游是重型 SPA（Vite 冷启动 + GraphQL 首屏），稳住再撤遮罩。
        window.setTimeout(() => {
          if (!cancelled) setBooting(false);
        }, 600);
      },
      onError: (d) => {
        if (cancelled) return;
        setBooting(false);
        setError(`${d.code}: ${d.message}`);
      },
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);

  const BrandPanel = host().ui?.BrandLogoLoaderPanel as
    | ComponentType<WorkspaceAppBrandLogoLoaderPanelProps>
    | undefined;

  return (
    <div style={WEB_ROOT_STYLE} data-testid={`workspace-mini-app-${TWENTY_APP_ID}-root`}>
      <div ref={guestHostRef} data-agnx-guest-surface-host="true" style={GUEST_HOST_STYLE} />
      {booting && !error && BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={LAYER} role="status">
          <BrandPanel title="正在启动 Twenty…" testID="twenty-boot-overlay" />
        </div>
      ) : null}
      {error ? (
        <div style={{ ...LAYER, overflow: "auto" }} role="alert">
          <div style={ERROR_TEXT_STYLE}>{error}</div>
        </div>
      ) : null}
    </div>
  );
}
