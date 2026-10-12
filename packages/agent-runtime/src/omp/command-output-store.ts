import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UiMessage } from "@pi-desktop/shared";
import { ompPreferencesPath } from "./preferences.js";

/** Desktop-only slash output; never injected into the agent's model context. */
export type OmpCommandOutputRecord = {
  id: string;
  /** Last tree entry of the active branch, including non-message entries. */
  anchor: string;
  command: string;
  output: string;
  createdAt: string;
  /** All output frames of one invocation share one input row. */
  invocationId?: string;
  /** The engine already persisted this invocation's user message. */
  userEntryId?: string;
};

export type OmpCommandSession = {
  sessionId: string;
  /** Renderer identity must survive restart, independently of the engine UUID/path. */
  desktopId?: string;
  sessionPath: string;
  cwd: string;
  createdAt: string;
};

const MAX_OUTPUT = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Output from authentication/configuration commands can contain credentials. */
const PRIVATE_COMMANDS = /^\/(?:login|logout|auth|config|env|secret|settings|setup|providers)/i;

export function ompCommandOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR?.trim()) return env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR.trim();
  return join(dirname(ompPreferencesPath(env)), "command-output");
}

function fileFor(sessionId: string, dir: string): string | undefined {
  return SAFE_ID.test(sessionId) ? join(dir, `${sessionId}.jsonl`) : undefined;
}

export function recordOmpCommandOutput(sessionId: string, record: OmpCommandOutputRecord, dir = ompCommandOutputDir()): void {
  if (!record.command.trim().startsWith("/") || PRIVATE_COMMANDS.test(record.command.trim())) return;
  const path = fileFor(sessionId, dir);
  if (!path) throw new Error("Invalid command-output session id");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = record.output.length > MAX_OUTPUT ? `${record.output.slice(0, MAX_OUTPUT)}\n…` : record.output;
  // Complete this append before publishing the UI row/turn end; reload cannot outrun it.
  // A leading delimiter also fences any torn trailing record from a prior crash.
  appendFileSync(path, `\n${JSON.stringify({ ...record, output })}\n`, { mode: 0o600 });
}

/** OMP deliberately does not materialize an empty session for local slash commands. */
export function recordOmpCommandSession(session: OmpCommandSession, dir = ompCommandOutputDir()): void {
  const path = fileFor(session.sessionId, dir);
  if (!path || !existsSync(path)) return;
  const manifest = `${path}.session`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${manifest}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 });
    renameSync(temporary, manifest);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function listOmpCommandSessions(dir = ompCommandOutputDir()): OmpCommandSession[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl.session")).flatMap((name) => {
    try {
      const session: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!session || typeof session !== "object" || !("sessionId" in session) || typeof session.sessionId !== "string" || !SAFE_ID.test(session.sessionId)
        || !("sessionPath" in session) || typeof session.sessionPath !== "string" || !("cwd" in session) || typeof session.cwd !== "string"
        || !("createdAt" in session) || typeof session.createdAt !== "string") return [];
      return [{ sessionId: session.sessionId, sessionPath: session.sessionPath, cwd: session.cwd, createdAt: session.createdAt, ...("desktopId" in session && typeof session.desktopId === "string" ? { desktopId: session.desktopId } : {}) }];
    } catch { return []; }
  });
}

export function readOmpCommandOutputs(sessionId: string, dir = ompCommandOutputDir()): OmpCommandOutputRecord[] {
  const path = fileFor(sessionId, dir);
  if (!path || !existsSync(path)) return [];
  const records: OmpCommandOutputRecord[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value?.id !== "string" || typeof value.anchor !== "string" || typeof value.output !== "string" || seen.has(value.id)) continue;
      if (typeof value.command !== "string" || PRIVATE_COMMANDS.test(value.command.trim())) continue;
      seen.add(value.id);
      records.push({
        id: value.id, anchor: value.anchor, command: value.command, output: value.output,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
        ...(typeof value.invocationId === "string" ? { invocationId: value.invocationId } : {}),
        ...(typeof value.userEntryId === "string" ? { userEntryId: value.userEntryId } : {}),
      });
    } catch { /* A torn trailing append is not a complete output row. */ }
  }
  return records;
}

export function commandOutputMessage(id: string, output: string, createdAt: string): UiMessage {
  return { id, role: "assistant", content: "```text\n" + output.replace(/```/g, "ʼʼʼ") + "\n```", createdAt, status: "complete" };
}

/** Preserve append order and emit one user row per invocation, never per output frame. */
export function mergeOmpCommandOutputs(messages: UiMessage[], records: OmpCommandOutputRecord[], branchIds = new Set(messages.map((message) => message.id)), branchOrder = [...branchIds]): UiMessage[] {
  if (records.length === 0) return messages;
  const byId = new Map<string, UiMessage>();
  for (const message of messages) byId.set(message.id, message);
  const after = new Map<string, UiMessage[]>();
  const inputs = new Set<string>();
  const seen = new Set<string>();
  const messageAnchors = new Map<string, string>();
  let last = "";
  for (const id of branchOrder) {
    if (byId.has(id)) last = id;
    messageAnchors.set(id, last);
  }
  for (const record of records) {
    if (seen.has(record.id) || (record.anchor && !branchIds.has(record.anchor))) continue;
    seen.add(record.id);
    const invocation = record.invocationId ?? record.id;
    const extra: UiMessage[] = [];
    const storedUser = record.userEntryId && byId.has(record.userEntryId);
    // Legacy rows anchored to an identical user message must not duplicate it.
    const anchorMessage = byId.get(record.anchor);
    const anchorUser = anchorMessage?.role === "user" && anchorMessage.content === record.command;
    if (!inputs.has(invocation) && !storedUser && !anchorUser && record.command.trim()) {
      extra.push({ id: `omp-command-in:${invocation}`, role: "user", content: record.command, createdAt: record.createdAt, status: "complete" });
    }
    inputs.add(invocation);
    extra.push(commandOutputMessage(`omp-command:${record.id}`, record.output, record.createdAt));
    const anchor = storedUser ? record.userEntryId! : messageAnchors.get(record.anchor) ?? record.anchor;
    const list = after.get(anchor) ?? [];
    list.push(...extra);
    after.set(anchor, list);
  }
  const merged = [...(after.get("") ?? [])];
  for (const message of messages) {
    merged.push(message);
    const extra = after.get(message.id);
    if (extra) merged.push(...extra);
  }
  return merged;
}
