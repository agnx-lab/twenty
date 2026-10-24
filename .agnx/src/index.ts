/**
 * 场景：Twenty CRM 子应用入口 —— 注册一个主面板（= 一类 Tab）+ 一个打开命令。
 */
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import {
  TWENTY_APP_ID,
  TWENTY_OPEN_COMMAND_ID,
  TWENTY_PANEL_ID,
} from "./constants";
import { bindTwentyHost, TwentyPanel } from "./panel";

export const appId = TWENTY_APP_ID;

export function activate(host: WorkspaceAppHostApi): () => void {
  bindTwentyHost(host);

  const disposers: Array<() => void> = [];

  disposers.push(
    host.registerMiniApp({
      id: TWENTY_PANEL_ID,
      appId: TWENTY_APP_ID,
      title: "Twenty",
      component: TwentyPanel,
      primaryPanel: true,
      iframeShortcutCapture: true,
    }),
  );

  disposers.push(
    host.registerCommand({
      id: TWENTY_OPEN_COMMAND_ID,
      appId: TWENTY_APP_ID,
      title: "Twenty CRM",
      keywords: ["twenty", "crm", "客户", "销售", "商机"],
      sidebarAction: { defaultVisible: true, label: "Twenty", order: 72 },
      run: (context) => {
        host.openSubAppTab({
          appId: TWENTY_APP_ID,
          panelId: TWENTY_PANEL_ID,
          serverId: context?.serverId,
          workspaceId: context?.workspaceId,
          currentPathname: context?.currentPathname,
        });
      },
    }),
  );

  return () => {
    for (const d of disposers.toReversed()) d();
  };
}

const moduleExport: WorkspaceAppModule = { appId: TWENTY_APP_ID, activate };
export default moduleExport;
