import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { IPC } from "@pi-desktop/shared";
import { chatWindows } from "./chat-windows";
import { getModuleDirectory } from "./module-path";

const launcherChannels: Record<string, true> = {
  [IPC.invoke.settingsGet]: true,
  [IPC.invoke.pluginList]: true,
  [IPC.invoke.pluginOpenPanel]: true,
  [IPC.invoke.pluginLauncherDismiss]: true,
};
const widgetChannels: Record<string, true> = {
  [IPC.invoke.settingsGet]: true,
  [IPC.invoke.liveVoiceWidgetVisibility]: true,
  [IPC.invoke.liveVoiceWidgetAction]: true,
};

/** Every desktop IPC entry point rejects unowned windows and child frames. */
export function assertRendererSender(
  event: IpcMainInvokeEvent,
  channel: string,
  auxiliary: { launcher: BrowserWindow | null; ownsWidget: (id: number) => boolean },
): void {
  if (chatWindows.list().some((window) => window.webContents.id === event.sender.id)) {
    chatWindows.sender(event);
    return;
  }
  let surface: string | undefined;
  if (auxiliary.launcher && !auxiliary.launcher.isDestroyed() &&
      auxiliary.launcher.webContents.id === event.sender.id && Object.hasOwn(launcherChannels, channel)) {
    surface = "plugin-launcher";
  } else if (auxiliary.ownsWidget(event.sender.id) && Object.hasOwn(widgetChannels, channel)) {
    surface = "live-voice-widget";
  }
  const expected = new URL(process.env.ELECTRON_RENDERER_URL ||
    pathToFileURL(join(getModuleDirectory(import.meta.url), "../renderer/index.html")).href);
  if (surface) expected.searchParams.set("surface", surface);
  if (!surface || event.sender.isDestroyed() || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== expected.href || event.sender.getURL() !== expected.href) {
    throw Object.assign(new Error("IPC requires an owned desktop main frame and allowed surface"), {
      errorCode: "PERMISSION_DENIED",
    });
  }
}
