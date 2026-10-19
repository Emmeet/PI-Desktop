/**
 * omp features that run outside a chat's omp process:
 * - whole-install usage (`omp stats --json`)
 * - undoing one omp edit
 * - OAuth sign-in for remote (HTTP/SSE) MCP servers. omp only runs that flow in
 *   its terminal UI, so a small bun helper drives omp's own MCP OAuth code
 *   (endpoint discovery, dynamic client registration, PKCE, local callback) and
 *   stores the token where omp looks it up (url-keyed credential).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, dialog, shell } from "electron";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { IPC, type ComposerCommand } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import { bunBinary, ompPackageDir, runOmp, runOmpConfig } from "../omp-capability-sync";
import { desktopDataDir } from "../data-paths";
import { isAllowedHttpUrl } from "../safe-open-external";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";

export const MCP_OAUTH_HELPER = `
const pkg = process.env.OMP_PKG_DIR;
const url = process.argv[2];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const { discoverOAuthEndpoints } = await import(pkg + "/src/mcp/oauth-discovery.ts");
const { MCPOAuthFlow, mcpOAuthCredentialId } = await import(pkg + "/src/mcp/oauth-flow.ts");
const { discoverAuthStorage } = await import(pkg + "/src/sdk.ts");
try {
  const ep = await discoverOAuthEndpoints(url);
  if (!ep) throw new Error("This server does not offer OAuth sign-in.");
  const ctrl = new AbortController();
  process.stdin.on("data", (d) => { if (String(d).includes("cancel")) ctrl.abort("cancelled"); });
  const flow = new MCPOAuthFlow({
    authorizationUrl: ep.authorizationUrl, tokenUrl: ep.tokenUrl, registrationUrl: ep.registrationUrl,
    issuerUrl: ep.issuerUrl, clientId: ep.clientId, scopes: ep.scopes,
    resource: ep.resource ?? url, stripSameOriginResource: !ep.resource,
  }, {
    onAuth: (i) => out({ type: "auth", url: i.url }),
    onProgress: (m) => out({ type: "progress", message: m }),
    signal: ctrl.signal,
  });
  const creds = await flow.login();
  const storage = await discoverAuthStorage();
  await storage.credentials.set(mcpOAuthCredentialId(url), {
    type: "oauth", ...creds, tokenUrl: ep.tokenUrl, clientId: flow.resolvedClientId,
    clientSecret: flow.registeredClientSecret, resource: flow.resource, authorizationUrl: flow.authorizationUrl,
  });
  out({ type: "done" });
  process.exit(0);
} catch (e) {
  out({ type: "error", message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
`;

/**
 * omp's slash catalog as composer rows. They are sent as prompt text and omp
 * runs them; omp only lists commands its RPC mode can execute.
 */
export function ompComposerCommands(
  commands: Array<{ name: string; description?: string; input?: { hint?: string }; source?: string }>,
): ComposerCommand[] {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = String(command?.name ?? "").replace(/^\//, "").trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{
      name,
      kind: "omp" as const,
      title: `/${name}`,
      ...(command.description ? { description: command.description } : {}),
      ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
    }];
  });
}

export type OmpMcpOAuthEvent =
  | { kind: "authUrl"; url: string }
  | { kind: "progress"; message: string };

function readMarker(): string[] {
  try {
    const value = JSON.parse(readFileSync(join(desktopDataDir(), "omp-mcp-oauth.json"), "utf8"));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** Whether omp holds an OAuth sign-in this app made for this server URL. */
export function ompMcpSignedIn(url: string | undefined): boolean {
  return Boolean(url) && readMarker().includes(String(url));
}

let running: { child: ChildProcessWithoutNullStreams; cancel: () => void } | null = null;

/** Stop the MCP sign-in in progress, if any. */
export function cancelOmpMcpOAuth(): boolean {
  if (!running) return false;
  running.cancel();
  return true;
}

/**
 * OAuth sign-in for a remote MCP server, run with omp's own MCP OAuth code so
 * omp (which hosts the server for every chat) finds the token. Resolves once
 * the browser step finished and the token is stored.
 */
export async function runOmpMcpOAuth(url: string, onEvent: (event: OmpMcpOAuthEvent) => void): Promise<void> {
  if (!isAllowedHttpUrl(url)) throw Object.assign(new Error("Enter the server's http(s) URL"), { errorCode: "INVALID_ARGUMENT" });
  if (running) throw Object.assign(new Error("Another MCP sign-in is in progress"), { errorCode: "AGENT_BUSY" });
  const pkg = ompPackageDir();
  if (!pkg) throw new Error("omp's install folder was not found, so MCP sign-in is unavailable");
  const dir = mkdtempSync(join(tmpdir(), "omp-mcp-oauth-"));
  try {
    const script = join(dir, "oauth.mjs");
    writeFileSync(script, MCP_OAUTH_HELPER);
    const child = spawn(bunBinary(), [script, url], { env: { ...process.env, OMP_PKG_DIR: pkg }, windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      let result: { ok: boolean; message?: string } | null = null;
      let buffer = "";
      let stderr = "";
      let settled = false;
      let cancelTimer: NodeJS.Timeout | undefined;
      const cancel = () => {
        if (settled || cancelTimer) return;
        try { child.stdin.write("cancel\n"); } catch { /* gone */ }
        cancelTimer = setTimeout(() => child.kill(), 1500);
        cancelTimer.unref?.();
      };
      const onQuit = () => { child.kill(); };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(cancelTimer);
        if (running?.child === child) running = null;
        app.removeListener("will-quit", onQuit);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.stdin.removeListener("error", onStdinError);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onStdinError = () => { /* Cancellation may race a helper closing its input. */ };
      const onStderr = (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-2000); };
      const onStdout = (chunk: Buffer) => {
        buffer += String(chunk);
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let event: unknown;
          try { event = JSON.parse(line); } catch { continue; }
          if (!event || typeof event !== "object" || !("type" in event)) continue;
          try {
            if (event.type === "auth" && "url" in event) {
              if (typeof event.url !== "string" || !isAllowedHttpUrl(event.url)) throw new Error("Invalid OAuth authorization URL");
              onEvent({ kind: "authUrl", url: event.url });
            } else if (event.type === "progress" && "message" in event && typeof event.message === "string") {
              onEvent({ kind: "progress", message: event.message });
            } else if (event.type === "done") result = { ok: true };
            else if (event.type === "error") result = { ok: false, message: "message" in event && typeof event.message === "string" ? event.message : undefined };
          } catch (error) {
            child.kill();
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
      };
      const onClose = () => {
        try {
          if (!result?.ok) throw Object.assign(new Error(result?.message ?? (stderr.trim().split("\n").at(-1) || "MCP sign-in was cancelled")), { cancelled: !result });
          const marked = readMarker();
          if (!marked.includes(url)) {
            mkdirSync(desktopDataDir(), { recursive: true });
            writeFileSync(join(desktopDataDir(), "omp-mcp-oauth.json"), JSON.stringify([...marked, url], null, 2));
          }
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      running = { child, cancel };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.stdin.on("error", onStdinError);
      child.once("error", onError);
      child.once("close", onClose);
      app.once("will-quit", onQuit);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const oneOf = (...values: string[]) => (value: unknown) => typeof value === "string" && values.includes(value);
const bool = (value: unknown) => typeof value === "boolean";
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
const themeName = (value: unknown) => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);

/** omp settings the renderer may read and change, with their allowed values. */
const OMP_SETTINGS: Record<string, (value: unknown) => boolean> = {
  "memory.backend": oneOf("off", "local", "hindsight", "mnemopi", "sharpshooter"),
  "memories.enabled": bool,
  "theme.dark": themeName,
  "theme.light": themeName,
  symbolPreset: oneOf("unicode", "nerd", "ascii"),
  "composer.predictions": bool,
  "spelling.autocomplete": oneOf("off", "auto", "ngram", "smollm", "apple"),
  "providers.cacheWarming": oneOf("off", "streaming", "idle"),
  "providers.anthropic.slowMode": oneOf("off", "auto"),
  "git.enabled": bool,
  "lsp.enabled": bool,
  "lsp.lazy": bool,
  "lsp.shared": bool,
  "lsp.formatOnWrite": bool,
  "lsp.diagnosticsOnWrite": bool,
  "lsp.diagnosticsOnEdit": bool,
  "lsp.diagnosticsDeduplicate": bool,
  "commit.mapReduceEnabled": bool,
  "commit.mapReduceThreshold": count,
  "commit.mapBatchTokenBudget": count,
  "commit.cacheEnabled": bool,
  "commit.cacheTtlDays": count,
  "commit.changelogMaxDiffChars": count,
};

/** omp's bundled TUI themes (pi-tui), with `vars` references resolved. */
function ompThemeDir(): string | null {
  const base = ompPackageDir();
  if (!base) return null;
  for (const candidate of [join(base, "..", "pi-tui", "src", "theme", "defaults"), join(base, "node_modules", "@oh-my-pi", "pi-tui", "src", "theme", "defaults")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function ompThemeNames(): string[] {
  const dir = ompThemeDir();
  if (!dir) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
}

export function ompThemePalette(name: string): Record<string, string> | null {
  const dir = ompThemeDir();
  if (!dir || !themeName(name)) return null;
  try {
    const theme = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as { vars?: Record<string, unknown>; colors?: Record<string, unknown> };
    const vars = theme.vars ?? {};
    const resolve = (value: unknown, depth = 0): string | null => {
      if (typeof value !== "string" || !value) return null;
      if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
      return depth < 5 && value in vars ? resolve(vars[value], depth + 1) : null;
    };
    const palette: Record<string, string> = {};
    for (const key of ["accent", "border", "borderAccent", "success", "error", "warning", "muted"]) {
      const color = resolve(theme.colors?.[key]);
      if (color) palette[key] = color;
    }
    return palette;
  } catch {
    return null;
  }
}

export function registerOmpExtrasIpc({
  registrar,
  getSidecar,
  sendToRenderer,
}: {
  registrar: IpcRegistrar;
  getSidecar?: () => { call<T = unknown>(method: string, params?: unknown): Promise<T> } | null | undefined;
  sendToRenderer?: (channel: string, payload: unknown) => void;
}): void {
  registrar.handle(IPC.invoke.ompConfigGet, async () => {
    // One `omp config list` instead of a process per key; only allow-listed
    // keys ever leave the main process (the list also holds auth settings).
    const listed = JSON.parse(await runOmpConfig(["list", "--json"], { timeoutMs: 30_000, maxBuffer: 8 << 20 })) as Record<string, { value?: unknown }>;
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(OMP_SETTINGS)) {
      if (listed[key] && "value" in listed[key]) values[key] = listed[key].value;
    }
    return { values };
  });

  registrar.handle(IPC.invoke.ompThemes, async () => {
    const names = ompThemeNames();
    const palettes: Record<string, Record<string, string>> = {};
    for (const name of names) {
      const palette = ompThemePalette(name);
      if (palette) palettes[name] = palette;
    }
    return { names, palettes };
  });
  // A dialog-selected, successfully generated file is the entire grant; no filesystem root is widened.
  const savedHtml = new Map<string, string>();
  for (const channel of [IPC.invoke.ompOpenExport, IPC.invoke.ompRevealExport]) {
    registrar.handleWithEvent(channel, async (event, input: unknown) => {
      (registrar.assertChatWindowSender ?? registrar.assertMainWindowSender)(event);
      const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
      if (typeof path !== "string" || !isAbsolute(path)) throw Object.assign(new Error("Export path is not authorized"), { errorCode: "PERMISSION_DENIED" });
      const canonical = savedHtml.get(resolve(path));
      if (!canonical || await realpath(path) !== canonical) throw Object.assign(new Error("Export path is not authorized"), { errorCode: "PERMISSION_DENIED" });
      if (channel === IPC.invoke.ompOpenExport) {
        const failure = await shell.openPath(canonical);
        if (failure) throw new Error(failure);
      } else shell.showItemInFolder(canonical);
      return { ok: true };
    });
  }

  registrar.handleWithEvent(IPC.invoke.ompExportHtml, async (event, input: { sessionId?: string; title?: string } = {}) => {
    (registrar.assertChatWindowSender ?? registrar.assertMainWindowSender)(event);
    const sessionId = input?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim() || /[\u0000-\u001f\u007f]/.test(sessionId)) throw Object.assign(new Error("sessionId is required"), { errorCode: "INVALID_ARGUMENT" });
    const safe = String(input?.title ?? "omp-session").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 80) || "omp-session";
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw new Error("chat window unavailable");
    const choice = await dialog.showSaveDialog(owner, {
      defaultPath: join(app.getPath("downloads"), `${safe}.html`),
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (choice.canceled || !choice.filePath) return { path: null };
    if (!isAbsolute(choice.filePath)) throw new Error("Export destination must be an absolute local path");
    if (owner.isDestroyed() || event.sender.isDestroyed()) return { path: null };
    const sidecar = getSidecar?.();
    if (!sidecar) throw new Error("agent sidecar unavailable");
    const reply = await sidecar.call<{ result?: { path?: string } }>("omp.session.command", {
      sessionId,
      command: { type: "export_html", outputPath: choice.filePath },
    });
    const path = reply?.result?.path;
    if (typeof path !== "string" || resolve(path) !== resolve(choice.filePath)) throw new Error("OMP returned an unexpected HTML export destination");
    const html = await readFile(path, "utf8");
    if (!/<(?:!doctype\s+html|html)(?:\s|>)/i.test(html)) throw new Error("OMP did not create an HTML document");
    savedHtml.set(resolve(path), await realpath(path));
    if (!owner.isDestroyed()) shell.showItemInFolder(path);
    return { path };
  });

  registrar.handle(IPC.invoke.ompConfigSet, async (input: { key?: string; value?: unknown } = {}) => {
    const key = typeof input?.key === "string" ? input.key : "";
    const valid = Object.hasOwn(OMP_SETTINGS, key) ? OMP_SETTINGS[key] : undefined;
    if (!valid || !valid(input?.value)) {
      throw Object.assign(new Error(`Not an allowed omp setting: ${key}`), { errorCode: "INVALID_ARGUMENT" });
    }
    await runOmpConfig(["set", key, String(input.value)]);
    // Idle chats restart with the new setting on their next message.
    await getSidecar?.()?.call("omp.runtimes.recycle", {});
    const listed = JSON.parse(await runOmpConfig(["list", "--json"], { timeoutMs: 30_000, maxBuffer: 8 << 20 })) as Record<string, { value?: unknown }>;
    const value = listed[key]?.value;
    if (!valid(value)) throw new Error("OMP returned an invalid setting value after saving");
    sendToRenderer?.(IPC.event.ompEvent, { method: "omp.config.changed", params: { key, value } });
    return { ok: true, value };
  });

  registrar.handle(IPC.invoke.ompUsageStats, async () => {
    const text = await runOmp(["stats", "--json"], { timeoutMs: 60_000, maxBuffer: 32 << 20 });
    const data = JSON.parse(text) as Record<string, unknown>;
    // The time series are large and only the dashboard uses them.
    return { overall: data.overall ?? {}, byModel: data.byModel ?? [], byFolder: data.byFolder ?? [], byAgentType: data.byAgentType ?? [] };
  });

  registrar.handleWithEvent(IPC.invoke.ompRevertEdit, async (event, input: { path?: string; oldText?: string; newText?: string } = {}) => {
    (registrar.assertChatWindowSender ?? registrar.assertMainWindowSender)(event);
    const path = input?.path;
    if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path) || typeof input?.oldText !== "string" || typeof input?.newText !== "string") {
      throw Object.assign(new Error("Nothing to revert"), { errorCode: "INVALID_ARGUMENT" });
    }
    const canonical = await realpath(path).catch(() => {
      throw Object.assign(new Error("The file no longer exists"), { errorCode: "NOT_FOUND" });
    });
    const original = await stat(canonical);
    if (!original.isFile()) throw Object.assign(new Error("Nothing to revert"), { errorCode: "INVALID_ARGUMENT" });
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw new Error("chat window unavailable");
    const strings = catalogs[resolveLocale(app.getLocale())];
    const approval = strings.omp.hostApproval;
    const choice = await dialog.showMessageBox(owner, {
      type: "warning",
      title: approval.title,
      message: strings.chat.ompEditRevert,
      detail: `${canonical}\n\n${approval.detail}`,
      buttons: [approval.deny, approval.allow],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1 || owner.isDestroyed() || event.sender.isDestroyed()) {
      throw Object.assign(new Error("File access denied by the user"), { errorCode: "PERMISSION_DENIED" });
    }
    const conflict = () => Object.assign(new Error("The file changed after this edit, so it was not reverted"), { errorCode: "CONFLICT" });
    if (await realpath(path).catch(() => null) !== canonical) throw conflict();
    const file = await open(canonical, "r+");
    try {
      const currentStat = await file.stat();
      if (currentStat.dev !== original.dev || currentStat.ino !== original.ino || !currentStat.isFile()) throw conflict();
      const current = await file.readFile("utf8");
      if (current === input.oldText) return { ok: true, alreadyReverted: true };
      if (current !== input.newText) throw conflict();
      const replacement = Buffer.from(input.oldText, "utf8");
      let written = 0;
      while (written < replacement.length) {
        const { bytesWritten } = await file.write(replacement, written, replacement.length - written, written);
        if (!bytesWritten) throw new Error("Unable to write reverted file");
        written += bytesWritten;
      }
      await file.truncate(replacement.length);
      return { ok: true };
    } finally {
      await file.close();
    }
  });

}
