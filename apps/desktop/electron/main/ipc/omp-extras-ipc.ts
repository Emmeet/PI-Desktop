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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { IPC, type ComposerCommand } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";

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

const OAUTH_MARKER = join(homedir(), ".pi-desktop", "omp-mcp-oauth.json");

function readMarker(): string[] {
  try {
    const value = JSON.parse(readFileSync(OAUTH_MARKER, "utf8"));
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** Whether omp holds an OAuth sign-in this app made for this server URL. */
export function ompMcpSignedIn(url: string | undefined): boolean {
  return Boolean(url) && readMarker().includes(String(url));
}

let running: ChildProcessWithoutNullStreams | null = null;

/** Stop the MCP sign-in in progress, if any. */
export function cancelOmpMcpOAuth(): boolean {
  const child = running;
  if (!child) return false;
  try { child.stdin.write("cancel\n"); } catch { /* gone */ }
  setTimeout(() => child.kill(), 1500).unref?.();
  return true;
}

/**
 * OAuth sign-in for a remote MCP server, run with omp's own MCP OAuth code so
 * omp (which hosts the server for every chat) finds the token. Resolves once
 * the browser step finished and the token is stored.
 */
export async function runOmpMcpOAuth(url: string, onEvent: (event: OmpMcpOAuthEvent) => void): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error("Enter the server's http(s) URL"), { errorCode: "INVALID_ARGUMENT" });
  if (running) throw Object.assign(new Error("Another MCP sign-in is in progress"), { errorCode: "AGENT_BUSY" });
  const { ompPackageDir, bunBinary } = await import("../omp-capability-sync");
  const pkg = ompPackageDir();
  if (!pkg) throw new Error("omp's install folder was not found, so MCP sign-in is unavailable");
  const dir = mkdtempSync(join(tmpdir(), "omp-mcp-oauth-"));
  const script = join(dir, "oauth.mjs");
  writeFileSync(script, MCP_OAUTH_HELPER);
  const child = spawn(bunBinary(), [script, url], { env: { ...process.env, OMP_PKG_DIR: pkg }, windowsHide: true });
  running = child;
  await new Promise<void>((resolve, reject) => {
    let result: { ok: boolean; message?: string } | null = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event: { type?: string; url?: string; message?: string };
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "auth" && event.url) onEvent({ kind: "authUrl", url: event.url });
        else if (event.type === "progress" && event.message) onEvent({ kind: "progress", message: event.message });
        else if (event.type === "done") result = { ok: true };
        else if (event.type === "error") result = { ok: false, message: event.message };
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.on("error", (error) => { if (running === child) running = null; reject(error); });
    child.on("exit", () => {
      if (running === child) running = null;
      rmSync(dir, { recursive: true, force: true });
      if (result?.ok) {
        const marked = readMarker();
        if (!marked.includes(url)) {
          mkdirSync(join(homedir(), ".pi-desktop"), { recursive: true });
          writeFileSync(OAUTH_MARKER, JSON.stringify([...marked, url], null, 2));
        }
        resolve();
      } else {
        reject(Object.assign(new Error(result?.message ?? (stderr.trim().split("\n").at(-1) || "MCP sign-in was cancelled")), {
          cancelled: !result,
        }));
      }
    });
  });
}

/** omp settings the renderer may read and change, with their allowed values. */
const OMP_SETTINGS: Record<string, (value: unknown) => boolean> = {
  "memory.backend": (value) => ["off", "local", "hindsight", "mnemopi", "sharpshooter"].includes(String(value)),
  "memories.enabled": (value) => typeof value === "boolean",
};

export function registerOmpExtrasIpc({
  registrar,
  getSidecar,
}: {
  registrar: IpcRegistrar;
  getSidecar?: () => { call<T = unknown>(method: string, params?: unknown): Promise<T> } | null | undefined;
}): void {
  registrar.handle(IPC.invoke.ompConfigGet, async () => {
    const { runOmpConfig } = await import("../omp-capability-sync");
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(OMP_SETTINGS)) {
      const raw = (await runOmpConfig(["get", key]).catch(() => "")).trim();
      values[key] = raw === "true" ? true : raw === "false" ? false : raw;
    }
    return { values };
  });

  registrar.handle(IPC.invoke.ompConfigSet, async (input: { key?: string; value?: unknown } = {}) => {
    const key = String(input?.key ?? "");
    const valid = OMP_SETTINGS[key];
    if (!valid || !valid(input?.value)) {
      throw Object.assign(new Error(`Not an allowed omp setting: ${key}`), { errorCode: "INVALID_ARGUMENT" });
    }
    const { runOmpConfig } = await import("../omp-capability-sync");
    await runOmpConfig(["set", key, String(input.value)]);
    // Idle chats restart with the new setting on their next message.
    await getSidecar?.()?.call("omp.runtimes.recycle", {}).catch(() => undefined);
    return { ok: true };
  });

  registrar.handle(IPC.invoke.ompUsageStats, async () => {
    const { runOmp } = await import("../omp-capability-sync");
    const text = await runOmp(["stats", "--json"], { timeoutMs: 60_000, maxBuffer: 32 << 20 });
    const data = JSON.parse(text) as Record<string, unknown>;
    // The time series are large and only the dashboard uses them.
    return { overall: data.overall ?? {}, byModel: data.byModel ?? [], byFolder: data.byFolder ?? [], byAgentType: data.byAgentType ?? [] };
  });

  registrar.handleWithEvent(IPC.invoke.ompRevertEdit, async (event, input: { path?: string; oldText?: string; newText?: string } = {}) => {
    registrar.assertMainWindowSender(event);
    const path = String(input?.path ?? "");
    if (!path || !isAbsolute(path) || typeof input?.oldText !== "string" || typeof input?.newText !== "string") {
      throw Object.assign(new Error("Nothing to revert"), { errorCode: "INVALID_ARGUMENT" });
    }
    let current: string;
    try {
      current = await readFile(path, "utf8");
    } catch {
      throw Object.assign(new Error("The file no longer exists"), { errorCode: "NOT_FOUND" });
    }
    if (current === input.oldText) return { ok: true, alreadyReverted: true };
    if (current !== input.newText) {
      throw Object.assign(new Error("The file changed after this edit, so it was not reverted"), { errorCode: "CONFLICT" });
    }
    await writeFile(path, input.oldText, "utf8");
    return { ok: true };
  });

}
