import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UiMessage } from "@pi-desktop/shared";
import { ompPreferencesPath } from "./preferences.js";

/**
 * omp does not write slash-command output (e.g. `/session`, `/usage`) into the
 * session file, so the app keeps its own copy and splices it back in after the
 * message it followed when the chat is reloaded.
 */
export type OmpCommandOutputRecord = {
  id: string;
  /** Last message id of the active branch when the command ran ("" for an empty chat). */
  anchor: string;
  command: string;
  output: string;
  createdAt: string;
};

const MAX_OUTPUT = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Commands whose output may carry login prompts or secrets are never stored. */
const PRIVATE_COMMANDS = /^\/(login|logout|auth|config|env|secret)/i;

export function ompCommandOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR?.trim()) return env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR.trim();
  return join(dirname(ompPreferencesPath(env)), "command-output");
}

function fileFor(sessionId: string, dir: string): string | undefined {
  return SAFE_ID.test(sessionId) ? join(dir, `${sessionId}.jsonl`) : undefined;
}

export function recordOmpCommandOutput(
  sessionId: string,
  record: OmpCommandOutputRecord,
  dir = ompCommandOutputDir(),
): void {
  if (PRIVATE_COMMANDS.test(record.command.trim())) return;
  const path = fileFor(sessionId, dir);
  if (!path) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const output = record.output.length > MAX_OUTPUT ? `${record.output.slice(0, MAX_OUTPUT)}\n…` : record.output;
    appendFileSync(path, `${JSON.stringify({ ...record, output })}\n`, { mode: 0o600 });
  } catch {
    // Best effort: losing a stored command output only loses it on reload.
  }
}

export function readOmpCommandOutputs(sessionId: string, dir = ompCommandOutputDir()): OmpCommandOutputRecord[] {
  const path = fileFor(sessionId, dir);
  if (!path || !existsSync(path)) return [];
  const records: OmpCommandOutputRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value?.id === "string" && typeof value.anchor === "string" && typeof value.output === "string") {
        records.push({
          id: value.id,
          anchor: value.anchor,
          command: typeof value.command === "string" ? value.command : "",
          output: value.output,
          createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
        });
      }
    } catch {
      // torn line
    }
  }
  return records;
}

export function commandOutputMessage(id: string, output: string, createdAt: string): UiMessage {
  return {
    id,
    role: "assistant",
    content: "```text\n" + output.replace(/```/g, "ʼʼʼ") + "\n```",
    createdAt,
    status: "complete",
  };
}

/** Splice stored command outputs back after the message each one followed. */
export function mergeOmpCommandOutputs(messages: UiMessage[], records: OmpCommandOutputRecord[]): UiMessage[] {
  if (records.length === 0) return messages;
  const ids = new Set(messages.map((message) => message.id));
  const after = new Map<string, UiMessage[]>();
  for (const record of records) {
    if (record.anchor && !ids.has(record.anchor)) continue; // another branch
    const extra: UiMessage[] = [];
    if (record.command.trim()) {
      extra.push({ id: `omp-command-in:${record.id}`, role: "user", content: record.command, createdAt: record.createdAt, status: "complete" });
    }
    extra.push(commandOutputMessage(`omp-command:${record.id}`, record.output, record.createdAt));
    const list = after.get(record.anchor) ?? [];
    list.push(...extra);
    after.set(record.anchor, list);
  }
  const merged: UiMessage[] = [...(after.get("") ?? [])];
  for (const message of messages) {
    merged.push(message);
    const extra = after.get(message.id);
    if (extra) merged.push(...extra);
  }
  return merged;
}
