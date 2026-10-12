import { app, BrowserWindow, globalShortcut, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { APP_NAME, IPC, KEYBOARD_SHORTCUTS, MAC_TRAFFIC_LIGHT_POSITION, keybindingToElectronAccelerator, resolveKeybinding } from "@pi-desktop/shared";
import type { KeybindingOverrides, ShortcutPlatform } from "@pi-desktop/shared";
import { recordHostGlobalBinding } from "./bootstrap/launcher";
import { getModuleDirectory } from "./module-path";

/** Only windows created by the host and their original main frame are trusted. */
export class ChatWindowRegistry {
  private readonly windows = new Map<BrowserWindow, string>();
  private lastFocused: BrowserWindow | null = null;

  add(window: BrowserWindow): void {
    const expectedUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(getModuleDirectory(import.meta.url), "../renderer/index.html")).href;
    this.windows.set(window, new URL(expectedUrl).href);
    window.on("focus", () => { this.lastFocused = window; });
    window.on("closed", () => {
      this.windows.delete(window);
      if (this.lastFocused === window) this.lastFocused = null;
    });
  }

  list(): BrowserWindow[] {
    return [...this.windows.keys()].filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed());
  }

  sender(event: IpcMainInvokeEvent): BrowserWindow {
    const window = this.list().find((candidate) => candidate.webContents.id === event.sender.id);
    const expected = window && this.windows.get(window);
    if (!window || !expected || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== expected || event.sender.getURL() !== expected) {
      throw Object.assign(new Error("renderer is not a trusted chat main frame"), { errorCode: "PERMISSION_DENIED" });
    }
    return window;
  }

  focused(): BrowserWindow | null {
    const windows = this.list();
    return windows.find((window) => window.isFocused()) ?? (this.lastFocused && windows.includes(this.lastFocused) ? this.lastFocused : windows[0] ?? null);
  }

  broadcast(channel: string, payload: unknown): void {
    const targets = channel === IPC.event.notificationActivated || channel === IPC.event.menuCommand
      ? [this.focused()].filter((window): window is BrowserWindow => window !== null)
      : this.list();
    for (const window of targets) {
      try { window.webContents.send(channel, payload); } catch { /* A closed frame may race a broadcast. */ }
    }
  }
}

export const chatWindows = new ChatWindowRegistry();

/** Secondary chat windows have separate renderer stores; plugins retain their primary-window owner. */
export async function createChatWindow(openExternal: (url: unknown) => Promise<void>, reportError: (error: unknown) => void): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION } : { frame: false }),
    webPreferences: {
      // Chromium shares origin zoom within a Session; each independent chat owns its zoom/cache.
      partition: `omp-chat-${randomUUID()}`,
      preload: join(getModuleDirectory(import.meta.url), "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
    },
  });
  chatWindows.add(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(reportError);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  const publishState = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.event.windowMaximized, { maximized: window.isMaximized() });
    window.webContents.send(IPC.event.windowFullScreen, { fullScreen: window.isFullScreen() });
  };
  window.on("maximize", publishState);
  window.on("unmaximize", publishState);
  window.on("enter-full-screen", publishState);
  window.on("leave-full-screen", publishState);
  window.webContents.on("did-finish-load", publishState);
  window.webContents.on("render-process-gone", (_event, details) => {
    reportError(new Error(`Chat renderer exited: ${details.reason}`));
    if (!window.isDestroyed() && details.reason !== "clean-exit") window.webContents.reload();
  });
  try {
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(getModuleDirectory(import.meta.url), "../renderer/index.html"));
    window.show();
    window.focus();
    return window;
  } catch (error) {
    window.destroy();
    throw error;
  }
}

let focusAccelerator: string | null = null;

export function applyFocusChatShortcut(keybindings: KeybindingOverrides | undefined, ensurePrimary: () => Promise<boolean>, reportError: (error: unknown) => void): void {
  if (!app.isReady()) return;
  const definition = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "focusChatWindow");
  if (!definition) return;
  const platform: ShortcutPlatform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const binding = resolveKeybinding(definition, keybindings, platform);
  const accelerator = keybindingToElectronAccelerator(binding, platform);
  recordHostGlobalBinding("focusChatWindow", binding);
  if (focusAccelerator === accelerator) return;
  if (focusAccelerator) globalShortcut.unregister(focusAccelerator);
  focusAccelerator = null;
  if (!accelerator) return;
  const registered = globalShortcut.register(accelerator, () => {
    void (async () => {
      if (!chatWindows.focused()) await ensurePrimary();
      const window = chatWindows.focused();
      if (!window) throw new Error("chat window unavailable");
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    })().catch(reportError);
  });
  if (registered) focusAccelerator = accelerator;
  else reportError(new Error(`Global chat shortcut unavailable: ${accelerator}`));
}

app.on("will-quit", () => {
  if (focusAccelerator) globalShortcut.unregister(focusAccelerator);
  focusAccelerator = null;
  recordHostGlobalBinding("focusChatWindow", null);
});
