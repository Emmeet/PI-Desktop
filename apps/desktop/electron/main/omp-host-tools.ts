import { clipboard, desktopCapturer, screen, shell } from "electron";
import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";

/**
 * Executes the desktop-side tools omp was given through `set_host_tools`
 * (see agent-runtime OMP_HOST_TOOLS) and the `clipboard://` URI scheme.
 * Requests arrive as `native.host.request` side events; answers go back
 * through the sidecar's `omp.host.respond`.
 */
type SidecarLike = { call<T = unknown>(method: string, params?: unknown): Promise<T> };
type Frame = { type: string; id: string; toolName?: string; arguments?: Record<string, unknown>; operation?: string; url?: string; content?: string };

const cancelled = new Set<string>();

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: Record<string, unknown> };
const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

export async function captureScreenPng(): Promise<{ data: string; width: number; height: number }> {
  const { width, height } = screen.getPrimaryDisplay().size;
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const source = sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture is unavailable on this system.");
  const size = source.thumbnail.getSize();
  return { data: source.thumbnail.toPNG().toString("base64"), width: size.width, height: size.height };
}

export async function runOmpHostTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "desktop_screenshot": {
      const shot = await captureScreenPng();
      return {
        content: [
          { type: "text", text: `Screenshot of the primary display (${shot.width}×${shot.height}).` },
          { type: "image", data: shot.data, mimeType: "image/png" },
        ],
        details: { width: shot.width, height: shot.height },
      };
    }
    case "desktop_open": {
      const target = String(args.target ?? "").trim();
      if (/^https?:\/\//i.test(target)) {
        await shell.openExternal(target);
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
      const value = String(args.text ?? "");
      clipboard.writeText(value);
      return text(`Copied ${value.length} characters to the clipboard.`);
    }
    default:
      throw new Error(`Unknown desktop tool: ${name}`);
  }
}

export async function handleOmpHostRequest(sidecar: SidecarLike, params: { sessionId?: string; frame?: Frame }): Promise<void> {
  const sessionId = String(params.sessionId ?? "");
  const frame = params.frame;
  if (!frame?.id) return;
  if (frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel") {
    cancelled.add(String((frame as { targetId?: string }).targetId ?? ""));
    return;
  }
  const respond = (reply: Record<string, unknown>) => {
    if (cancelled.delete(frame.id)) return Promise.resolve();
    return sidecar.call("omp.host.respond", { sessionId, frame: { ...reply, id: frame.id } }).then(() => undefined);
  };
  if (frame.type === "host_tool_call") {
    try {
      const result = await runOmpHostTool(String(frame.toolName ?? ""), frame.arguments ?? {});
      await respond({ type: "host_tool_result", result });
    } catch (error) {
      await respond({ type: "host_tool_result", result: text(error instanceof Error ? error.message : String(error)), isError: true });
    }
    return;
  }
  if (frame.type === "host_uri_request") {
    try {
      const url = String(frame.url ?? "");
      if (!url.startsWith("clipboard://")) throw new Error(`Unsupported URI: ${url}`);
      if (frame.operation === "write") {
        clipboard.writeText(String(frame.content ?? ""));
        await respond({ type: "host_uri_result" });
      } else {
        await respond({ type: "host_uri_result", content: clipboard.readText(), contentType: "text/plain" });
      }
    } catch (error) {
      await respond({ type: "host_uri_result", isError: true, content: error instanceof Error ? error.message : String(error) });
    }
  }
}
