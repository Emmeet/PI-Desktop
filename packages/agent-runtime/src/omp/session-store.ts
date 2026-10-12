import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UiMessage } from "@pi-desktop/shared";

/** Parsed view of one omp session file (`~/.omp/agent/sessions/<cwd>/<ts>_<id>.jsonl`). */
export type OmpSessionFile = {
  path: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  providerId?: string;
  modelId?: string;
  messages: UiMessage[];
};

type Entry = Record<string, any>;

export function textOf(content: unknown): { text: string; thinking?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
  }
  return { text: text.join("\n"), ...(thinking.length ? { thinking: thinking.join("\n") } : {}) };
}

export function splitModel(value: unknown): { providerId?: string; modelId?: string } {
  if (typeof value !== "string" || !value) return {};
  const slash = value.indexOf("/");
  return slash > 0 ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) } : { modelId: value };
}

/** Project one omp `message` payload to the app's UiMessage shape. */
export function projectMessage(
  id: string,
  createdAt: string,
  message: any,
  toolArgs?: Map<string, unknown>,
): UiMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = textOf(message.content);
  if (message.role === "user") {
    if (message.attribution && message.attribution !== "user") return undefined;
    return { id, role: "user", content: content.text, createdAt, status: "complete" };
  }
  if (message.role === "assistant") {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && typeof block.id === "string") toolArgs?.set(block.id, block.arguments);
      }
    }
    return {
      id,
      role: "assistant",
      content: content.text,
      ...(content.thinking ? { thinking: content.thinking } : {}),
      createdAt,
      status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "complete",
      ...(typeof message.model === "string" ? { modelId: message.model } : {}),
      ...(typeof message.provider === "string" ? { providerId: message.provider } : {}),
    };
  }
  if (message.role === "toolResult") {
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    return {
      id,
      role: "tool",
      content: content.text,
      createdAt,
      status: "complete",
      toolCallId,
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
      ...(toolCallId && toolArgs?.has(toolCallId) ? { toolArgs: toolArgs.get(toolCallId) } : {}),
      toolResult: message.details ?? message.content,
      toolStatus: message.isError ? "error" : "success",
      isError: message.isError === true,
    };
  }
  return undefined;
}

export function parseOmpSession(path: string, text = readFileSync(path, "utf8")): OmpSessionFile | undefined {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") entries.push(value);
    } catch {
      // A torn trailing line from a live writer; skip it.
    }
  }
  const header = entries.find((entry) => entry.type === "session");
  if (!header || typeof header.id !== "string") return undefined;
  let title: string | undefined;
  for (const entry of entries) {
    if (entry.type === "title" && typeof entry.title === "string" && entry.title.trim()) title = entry.title.trim();
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) title = entry.name.trim();
  }
  // Active branch: walk parentId links back from the last tree entry.
  const byId = new Map<string, Entry>();
  let leaf: Entry | undefined;
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.type !== "session") {
      byId.set(entry.id, entry);
      leaf = entry;
    }
  }
  const branch: Entry[] = [];
  const seen = new Set<string>();
  for (let cursor = leaf; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) {
    seen.add(cursor.id);
    branch.push(cursor);
  }
  branch.reverse();
  const toolArgs = new Map<string, unknown>();
  const messages: UiMessage[] = [];
  let model: { providerId?: string; modelId?: string } = {};
  for (const entry of branch) {
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : header.timestamp;
    if (entry.type === "model_change") model = splitModel(entry.model ?? (entry.provider && entry.modelId ? `${entry.provider}/${entry.modelId}` : undefined));
    else if (entry.type === "message") {
      const projected = projectMessage(entry.id, ts, entry.message, toolArgs);
      if (projected) messages.push(projected);
      if (entry.message?.role === "assistant" && typeof entry.message.provider === "string" && typeof entry.message.model === "string") {
        model = { providerId: entry.message.provider, modelId: entry.message.model };
      }
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
      messages.push({ id: entry.id, role: "system", content: entry.summary, createdAt: ts, status: "complete" });
    }
  }
  const createdAt = typeof header.timestamp === "string" ? header.timestamp : new Date(statSync(path).birthtimeMs).toISOString();
  const firstUser = messages.find((message) => message.role === "user");
  return {
    path,
    sessionId: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    createdAt,
    updatedAt: branch.at(-1)?.timestamp ?? createdAt,
    title: title ?? (firstUser ? firstUser.content.slice(0, 80) : undefined),
    ...model,
    messages,
  };
}

export function listOmpSessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      // Subagent/artifact sessions live in per-session folders; only top-level
      // conversation files directly under a cwd folder are user sessions.
      if (entry.isDirectory() && directory === root) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}
