import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "@pi-desktop/shared/protocol";

const LOCALE_ARGUMENT_PREFIX = "--pi-desktop-locale=";

function readOsLocale(): string | undefined {
  return process.argv
    .find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX))
    ?.slice(LOCALE_ARGUMENT_PREFIX.length);
}

const invokeChannels: Record<string, true> = Object.fromEntries(
  Object.values(IPC.invoke).map((channel) => [channel, true as const]),
);
const eventChannels: Record<string, true> = Object.fromEntries(
  Object.values(IPC.event).map((channel) => [channel, true as const]),
);

function assertChannel(channels: Record<string, true>, channel: string) {
  if (!Object.hasOwn(channels, channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

const api = {
  invoke: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    assertChannel(invokeChannels, channel);
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    assertChannel(eventChannels, channel);
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onLiveVoicePort: () => {
    const listener = (event: Electron.IpcRendererEvent, payload: unknown) => {
      const value = payload && typeof payload === "object" ? payload as { callId?: unknown; nonce?: unknown } : null;
      const port = event.ports[0];
      if (!port || typeof value?.callId !== "string" || typeof value.nonce !== "string") return;
      window.postMessage({ kind: "pi-desktop-live-voice-port", callId: value.callId, nonce: value.nonce }, "*", [port]);
    };
    ipcRenderer.on(IPC.event.liveVoicePort, listener);
    return () => ipcRenderer.removeListener(IPC.event.liveVoicePort, listener);
  },
  channels: IPC,
  // Synchronous platform info so the renderer can style window chrome
  // (traffic lights on macOS vs. controls overlay on Windows/Linux)
  // before first paint, without an IPC round-trip.
  platform: process.platform,
  // `app.getLocale()` is resolved in the main process and passed as a renderer
  // creation argument. This keeps the locale available before first paint
  // without importing Electron's main-only `app` module in the sandbox.
  locale: readOsLocale(),
  /** Resolve a real dropped File without exposing Node or Electron to the page. */
  getDroppedFilePath: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);

export type PiDesktopPreloadApi = typeof api;
