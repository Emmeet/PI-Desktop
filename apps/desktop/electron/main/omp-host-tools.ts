import { app, clipboard, desktopCapturer, dialog, screen, shell } from "electron";
import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { isAllowedHttpUrl, openAllowedExternal } from "./safe-open-external";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";

function approvalAction(action: "screenshot" | "open" | "clipboardRead" | "clipboardWrite"): string {
  return catalogs[resolveLocale(app.getLocale())].omp.hostApproval[action];
}
async function approveHostRequest(sessionId: string, action: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const labels = catalogs[resolveLocale(app.getLocale())].omp.hostApproval;
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: labels.title,
    message: labels.message.replace("{action}", action).replace("{sessionId}", sessionId),
    detail: labels.detail,
    buttons: [labels.deny, labels.allow],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  });
  signal.throwIfAborted();
  if (choice.response !== 1) throw new Error("Desktop access denied by the user");
}

/** Shapes from omp 18.10.1 modes/rpc/rpc-types.ts, not renderer tool calls. */
type SidecarLike = { call<T = unknown>(method: string, params?: unknown): Promise<T> };
type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: Record<string, unknown> };
const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const pending = new WeakMap<SidecarLike, Map<string, Map<string, AbortController>>>();
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);

/** Cancellation is scoped to both process and session; unknown/late ids retain no state. */
export function cancelOmpHostRequests(sidecar: SidecarLike, sessionId?: string): void {
  const sessions = pending.get(sidecar);
  if (!sessions) return;
  for (const [id, calls] of sessions) {
    if (sessionId !== undefined && id !== sessionId) continue;
    for (const controller of calls.values()) controller.abort();
    sessions.delete(id);
  }
  if (!sessions.size) pending.delete(sidecar);
}

export async function captureScreenPng(): Promise<{ data: string; width: number; height: number }> {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const source = sources.find((candidate) => candidate.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture of the primary display is unavailable on this system.");
  const size = source.thumbnail.getSize();
  return { data: source.thumbnail.toPNG().toString("base64"), width: size.width, height: size.height };
}

/** Validate the entire native request before showing consent or touching the OS. */
function validateToolArguments(name: string, args: Record<string, unknown>): void {
  if (!["desktop_screenshot", "desktop_open", "desktop_clipboard_read", "desktop_clipboard_write"].includes(name)) throw new Error(`Unknown desktop tool: ${name}`);
  const allowed = name === "desktop_open" ? ["target"] : name === "desktop_clipboard_write" ? ["text"] : [];
  if (!record(args) || Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("Invalid desktop tool arguments");
  if (name === "desktop_clipboard_write" && typeof args.text !== "string") throw new Error("text must be a string");
  if (name === "desktop_open") {
    if (typeof args.target !== "string" || !args.target.trim() || /[\u0000-\u001f\u007f]/.test(args.target)) throw new Error("target must be an absolute path or an http(s) URL");
    const target = args.target.trim();
    if (!isAllowedHttpUrl(target) && !isAbsolute(target)) throw new Error("target must be an absolute path or an http(s) URL");
  }
}

export async function runOmpHostTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  signal?.throwIfAborted();
  validateToolArguments(name, args);
  switch (name) {
    case "desktop_screenshot": {
      const shot = await captureScreenPng();
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: `Screenshot of the primary display (${shot.width}×${shot.height}).` }, { type: "image", data: shot.data, mimeType: "image/png" }], details: { width: shot.width, height: shot.height } };
    }
    case "desktop_open": {
      if (typeof args.target !== "string" || !args.target.trim() || /[\u0000-\u001f\u007f]/.test(args.target)) throw new Error("target must be an absolute path or an http(s) URL");
      const target = args.target.trim();
      if (isAllowedHttpUrl(target)) {
        await openAllowedExternal(target, (url) => shell.openExternal(url));
        return text(`Opened ${target} in the default browser.`);
      }
      if (!isAbsolute(target)) throw new Error("target must be an absolute path or an http(s) URL");
      if (!existsSync(target)) throw new Error(`No such file: ${target}`);
      const failure = await shell.openPath(target);
      if (failure) throw new Error(failure);
      return text(`Opened ${target} with the default application.`);
    }
    case "desktop_clipboard_read":
      return text(clipboard.readText());
    case "desktop_clipboard_write": {
      if (typeof args.text !== "string") throw new Error("text must be a string");
      clipboard.writeText(args.text);
      return text(`Copied ${args.text.length} characters to the clipboard.`);
    }
    default:
      throw new Error(`Unknown desktop tool: ${name}`);
  }
}

function validateClipboardUri(value: unknown): void {
  if (typeof value !== "string" || !/^clipboard:\/\/(?:text)?$/i.test(value)) throw new Error("Only clipboard:// and clipboard://text are supported");
  const url = new URL(value);
  if (url.protocol !== "clipboard:" || url.username || url.password || url.port || url.search || url.hash || url.pathname) throw new Error("Invalid clipboard URI");
}

export async function handleOmpHostRequest(sidecar: SidecarLike, params: unknown): Promise<void> {
  if (!record(params) || !identifier(params.sessionId) || !record(params.frame) || !identifier(params.frame.id)) throw new Error("Malformed omp host request");
  const { sessionId, frame } = params;
  const id = frame.id as string;
  if (frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel") {
    if (!identifier(frame.targetId)) throw new Error("Malformed omp cancellation");
    const calls = pending.get(sidecar)?.get(sessionId);
    calls?.get(frame.targetId)?.abort();
    calls?.delete(frame.targetId);
    if (!calls?.size) pending.get(sidecar)?.delete(sessionId);
    return;
  }
  if (frame.type !== "host_tool_call" && frame.type !== "host_uri_request") throw new Error("Unsupported omp host frame");
  let sessions = pending.get(sidecar);
  if (!sessions) { sessions = new Map(); pending.set(sidecar, sessions); }
  let calls = sessions.get(sessionId);
  if (!calls) { calls = new Map(); sessions.set(sessionId, calls); }
  if (calls.has(id)) throw new Error("Duplicate omp host request id");
  const controller = new AbortController();
  calls.set(id, controller);
  let reply: Record<string, unknown>;
  try {
    if (frame.type === "host_tool_call") {
      if (!identifier(frame.toolCallId) || !identifier(frame.toolName) || !record(frame.arguments)) throw new Error("Malformed omp host tool call");
      validateToolArguments(frame.toolName, frame.arguments);
      const key = frame.toolName === "desktop_screenshot" ? "screenshot" : frame.toolName === "desktop_open" ? "open" : frame.toolName === "desktop_clipboard_read" ? "clipboardRead" : "clipboardWrite";
      const action = frame.toolName === "desktop_open" ? `${approvalAction(key)}: ${String(frame.arguments.target)}` : approvalAction(key);
      await approveHostRequest(sessionId, action, controller.signal);
      reply = { type: "host_tool_result", result: await runOmpHostTool(frame.toolName, frame.arguments, controller.signal) };
    } else {
      validateClipboardUri(frame.url);
      if (frame.operation === "write") {
        if (typeof frame.content !== "string") throw new Error("Clipboard write requires string content");
        await approveHostRequest(sessionId, approvalAction("clipboardWrite"), controller.signal);
        controller.signal.throwIfAborted();
        clipboard.writeText(frame.content);
        reply = { type: "host_uri_result" };
      } else if (frame.operation === "read") {
        if (frame.content !== undefined) throw new Error("Clipboard read does not accept content");
        await approveHostRequest(sessionId, approvalAction("clipboardRead"), controller.signal);
        reply = { type: "host_uri_result", content: clipboard.readText(), contentType: "text/plain" };
      } else throw new Error("Unsupported clipboard operation");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply = frame.type === "host_tool_call" ? { type: "host_tool_result", result: text(message), isError: true } : { type: "host_uri_result", isError: true, error: message };
  }
  try {
    if (!controller.signal.aborted) await sidecar.call("omp.host.respond", { sessionId, frame: { ...reply, id } });
  } finally {
    if (calls.get(id) === controller) calls.delete(id);
    if (!calls.size && sessions.get(sessionId) === calls) sessions.delete(sessionId);
    if (!sessions.size && pending.get(sidecar) === sessions) pending.delete(sidecar);
  }
}
