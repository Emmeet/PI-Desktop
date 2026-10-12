import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentEvent,
  AgentEventEnvelope,
  SessionDetail,
  SessionSearchPage,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { NATIVE_PI_SESSION_PREFIX } from "../native-pi-session-id.js";
import { resolveOmpBinary } from "./binary.js";
import { OmpRpcProcess, type OmpFrame } from "./rpc-process.js";
import { listOmpSessionFiles, parseOmpSession, projectMessage, textOf, type OmpSessionFile } from "./session-store.js";

export type OmpNotifier = (envelope: AgentEventEnvelope) => void;

/**
 * omp agent directory. `PI_DESKTOP_OMP_AGENT_DIR` overrides; otherwise omp's
 * own `PI_CODING_AGENT_DIR` override is honored, then `~/.omp/agent`.
 */
export function ompAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PI_DESKTOP_OMP_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  return resolve(explicit || join(homedir(), ".omp", "agent"));
}

type SessionRecord = {
  id: string;
  cwd: string;
  /** Unset until omp writes the file for a session created in the app. */
  path?: string;
  createdAt: string;
  title?: string;
};

function stableId(path: string): string {
  return `${NATIVE_PI_SESSION_PREFIX}${createHash("sha256").update(path).digest("base64url").slice(0, 24)}`;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function searchExcerpt(text: string, query: string, budget = 180): string {
  if (text.length <= budget) return text;
  const match = text.toLowerCase().indexOf(query.toLowerCase());
  const start = match < 0 ? 0 : Math.max(0, match - Math.floor(budget / 3));
  const end = Math.min(text.length, start + budget);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** One live omp process bound to one session. */
class OmpSessionRuntime {
  private turnId?: string;
  private promptRequestId?: string;
  private userMessageId?: string;
  private currentAssistant?: UiMessage;
  private readonly toolArgs = new Map<string, unknown>();
  sessionFile?: string;

  private constructor(
    readonly id: string,
    private readonly rpc: OmpRpcProcess,
    private notify: OmpNotifier,
    private readonly onSessionFile: (path: string) => void,
    private readonly onExit: () => void,
  ) {
    rpc.onFrame((frame) => this.onFrame(frame));
    rpc.onExit((reason) => {
      if (this.turnId) {
        this.emit({ type: "error", error: { code: "OMP_PROCESS_EXITED", message: reason, retriable: true } });
        this.finish();
      }
      this.onExit();
    });
  }

  static async start(input: {
    id: string;
    cwd: string;
    sessionPath?: string;
    agentDir: string;
    notify: OmpNotifier;
    onSessionFile: (path: string) => void;
    onExit: () => void;
  }): Promise<OmpSessionRuntime> {
    const binary = resolveOmpBinary();
    const args = ["--cwd", input.cwd];
    if (input.sessionPath) args.push("--resume", input.sessionPath);
    const model = process.env.PI_DESKTOP_OMP_MODEL?.trim();
    if (model && !input.sessionPath) args.push("--model", model);
    const env = { ...process.env };
    // Keep the child on the same agent dir the app lists sessions from.
    if (process.env.PI_DESKTOP_OMP_AGENT_DIR?.trim()) env.PI_CODING_AGENT_DIR = input.agentDir;
    const rpc = new OmpRpcProcess(binary, args, { cwd: input.cwd, env });
    const runtime = new OmpSessionRuntime(input.id, rpc, input.notify, input.onSessionFile, input.onExit);
    try {
      await Promise.race([
        rpc.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("omp did not become ready within 60s")), 60_000)),
      ]);
      await runtime.refreshSessionFile();
    } catch (error) {
      rpc.dispose();
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        errorCode: (error as any)?.errorCode ?? "OMP_START_FAILED",
      });
    }
    return runtime;
  }

  get isRunning(): boolean {
    return this.turnId !== undefined;
  }

  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  get alive(): boolean {
    return this.rpc.isAlive;
  }

  async refreshSessionFile(): Promise<void> {
    const state = await this.rpc.request<{ sessionFile?: string }>({ type: "get_state" });
    if (state?.sessionFile && state.sessionFile !== this.sessionFile) {
      this.sessionFile = state.sessionFile;
      this.onSessionFile(state.sessionFile);
    }
  }

  setNotifier(notify: OmpNotifier): void {
    this.notify = notify;
  }

  async prompt(content: string, turnId: string, userMessageId?: string): Promise<void> {
    if (this.isRunning) throw Object.assign(new Error("session already has an active turn"), { errorCode: "AGENT_BUSY" });
    this.turnId = turnId;
    this.userMessageId = userMessageId;
    this.promptRequestId = this.rpc.nextId("prompt");
    this.emit({ type: "agent_start" });
    try {
      const data = await this.rpc.request<{ agentInvoked?: boolean }>({ id: this.promptRequestId, type: "prompt", message: content });
      // A local slash command finished without an agent turn; no prompt_result follows.
      if (data && data.agentInvoked === false) this.finish();
    } catch (error) {
      this.finish();
      throw error;
    }
  }

  async abort(expectedTurnId?: string): Promise<boolean> {
    if (!this.turnId || (expectedTurnId !== undefined && expectedTurnId !== this.turnId)) return false;
    await this.rpc.request({ type: "abort" }).catch(() => undefined);
    return true;
  }

  dispose(): void {
    this.rpc.dispose();
  }

  private emit(event: AgentEvent): void {
    this.notify({ sessionId: this.id, turnId: this.turnId, ts: Date.now(), event });
  }

  private finish(): void {
    if (!this.turnId) return;
    if (this.currentAssistant) {
      this.emit({ type: "message_end", message: { ...this.currentAssistant, status: "aborted" }, replacesMessageId: this.currentAssistant.id });
      this.currentAssistant = undefined;
    }
    this.emit({ type: "agent_end", messageIds: [] });
    this.turnId = undefined;
    this.userMessageId = undefined;
    this.promptRequestId = undefined;
  }

  private onFrame(frame: OmpFrame): void {
    switch (frame.type) {
      case "prompt_result": {
        if (frame.id !== this.promptRequestId) return;
        if (frame.status === "error" && frame.error) {
          this.emit({
            type: "error",
            error: {
              code: "OMP_PROMPT_ERROR",
              message: String(frame.error.message ?? "omp prompt failed"),
              retriable: frame.error.retryable === true,
            },
          });
        }
        void this.refreshSessionFile().catch(() => undefined);
        this.finish();
        return;
      }
      case "response": {
        if (frame.id === this.promptRequestId && frame.success === false) {
          this.emit({ type: "error", error: { code: "OMP_PROMPT_REJECTED", message: String(frame.error ?? "prompt rejected"), retriable: false } });
          this.finish();
        }
        return;
      }
    }
    if (!this.turnId) return;
    switch (frame.type) {
      case "turn_start":
        this.emit({ type: "turn_start" });
        return;
      case "turn_end":
        this.emit({ type: "turn_end" });
        return;
      case "message_start": {
        if (frame.message?.role !== "assistant") return;
        const content = textOf(frame.message.content);
        this.currentAssistant = {
          id: randomUUID(),
          role: "assistant",
          content: content.text,
          ...(content.thinking ? { thinking: content.thinking } : {}),
          createdAt: new Date().toISOString(),
          status: "streaming",
        };
        this.emit({ type: "message_start", message: this.currentAssistant });
        return;
      }
      case "message_update": {
        const partial = frame.assistantMessageEvent?.partial ?? frame.message;
        if (!this.currentAssistant || !partial) return;
        const content = textOf(partial.content);
        this.currentAssistant = { ...this.currentAssistant, content: content.text, thinking: content.thinking, status: "streaming" };
        this.emit({ type: "message_update", message: this.currentAssistant });
        return;
      }
      case "message_end": {
        const message = frame.message;
        const id = typeof frame.messageId === "string" ? frame.messageId : randomUUID();
        if (message?.role === "user") {
          const projected = projectMessage(this.userMessageId ?? id, new Date().toISOString(), message);
          if (projected && this.userMessageId) {
            this.emit({ type: "user_message_persisted", optimisticMessageId: this.userMessageId, message: projected });
            this.userMessageId = undefined;
          }
          return;
        }
        if (message?.role === "assistant") {
          const live = this.currentAssistant;
          const projected = projectMessage(live?.id ?? id, live?.createdAt ?? new Date().toISOString(), message, this.toolArgs);
          this.currentAssistant = undefined;
          if (projected) this.emit({ type: "message_end", message: projected, ...(live ? { replacesMessageId: live.id } : {}) });
          return;
        }
        // toolResult messages are already represented live by tool_start /
        // tool_end; re-emitting them would render each tool call twice.
        return;
      }
      case "tool_execution_start":
        this.toolArgs.set(frame.toolCallId, frame.args);
        this.emit({ type: "tool_start", toolCallId: frame.toolCallId, toolName: frame.toolName, args: frame.args });
        return;
      case "tool_execution_update":
        this.emit({ type: "tool_update", toolCallId: frame.toolCallId, partialResult: frame.partialResult });
        return;
      case "tool_execution_end":
        this.emit({ type: "tool_end", toolCallId: frame.toolCallId, result: frame.result, isError: frame.isError === true });
        return;
    }
  }
}

/**
 * omp-backed session service. Lists and reads omp's own session files and
 * drives each conversation through a dedicated `omp --mode rpc` process.
 * omp handles models (models.yml), credentials, tools, and persistence.
 */
export class OmpSessionService {
  readonly agentDir: string;
  private readonly root: string;
  private readonly records = new Map<string, SessionRecord>();
  private readonly pathIds = new Map<string, string>();
  private readonly runtimes = new Map<string, OmpSessionRuntime>();
  private readonly opening = new Map<string, Promise<OmpSessionRuntime>>();

  constructor(options: { agentDir?: string; sessionRoot?: string } = {}) {
    this.agentDir = resolve(options.agentDir ?? ompAgentDir());
    this.root = resolve(options.sessionRoot ?? join(this.agentDir, "sessions"));
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  create(input: { projectPath?: string | null; title?: string } = {}): SessionSummary {
    const cwd = resolve(input.projectPath?.trim() || homedir());
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw Object.assign(new Error(`Project folder does not exist: ${cwd}`), { errorCode: "INVALID_ARGUMENT" });
    }
    const id = `${NATIVE_PI_SESSION_PREFIX}new-${randomUUID()}`;
    const record: SessionRecord = { id, cwd, createdAt: new Date().toISOString(), title: input.title?.trim() || undefined };
    this.records.set(id, record);
    return this.summary(record, undefined);
  }

  private idForPath(path: string): string {
    return this.pathIds.get(path) ?? stableId(path);
  }

  private summary(record: SessionRecord, file: OmpSessionFile | undefined): SessionSummary {
    const runtime = this.runtimes.get(record.id);
    return {
      id: record.id,
      title: file?.title ?? record.title ?? "New omp session",
      messageCount: file?.messages.length ?? 0,
      ...(record.cwd && existsSync(record.cwd) ? { projectPath: record.cwd } : {}),
      ...(file?.providerId ? { providerId: file.providerId } : {}),
      ...(file?.modelId ? { modelId: file.modelId } : {}),
      mode: "agent",
      thinkingLevel: "off",
      permissionMode: "inherit",
      source: "pi-native",
      nativeHarness: "omp",
      capabilities: { canPrompt: true, canStop: runtime?.isRunning ?? false, canRefresh: true },
      createdAt: file?.createdAt ?? record.createdAt,
      updatedAt: file?.updatedAt ?? record.createdAt,
    } as SessionSummary;
  }

  private readFile(record: SessionRecord): OmpSessionFile | undefined {
    if (!record.path || !existsSync(record.path)) return undefined;
    return parseOmpSession(record.path);
  }

  async list(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const seenPaths = new Set<string>();
    let root: string | undefined;
    try { root = realpathSync(this.root); } catch { root = undefined; }
    if (root) {
      for (const candidate of listOmpSessionFiles(root)) {
        try {
          const path = realpathSync(candidate);
          if (!inside(root, path)) continue;
          const file = parseOmpSession(path);
          if (!file || file.messages.length === 0) continue;
          const id = this.idForPath(path);
          const existing = this.records.get(id);
          const record: SessionRecord = { id, cwd: file.cwd, path, createdAt: file.createdAt, title: existing?.title };
          this.records.set(id, record);
          seenPaths.add(path);
          summaries.push(this.summary(record, file));
        } catch {
          // Unreadable or mid-write; retried on the next refresh.
        }
      }
    }
    // Sessions created in the app that have no persisted conversation yet.
    const emitted = new Set(summaries.map((summary) => summary.id));
    for (const record of this.records.values()) {
      if (emitted.has(record.id) || (record.path && seenPaths.has(record.path))) continue;
      if (record.path && !this.pathIds.has(record.path)) continue; // vanished external file
      summaries.push(this.summary(record, undefined));
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async search(query: string): Promise<SessionSearchPage> {
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextOffset: null };
    if (normalized.length > 500) throw new Error("query exceeds 500 characters");
    const needle = normalized.toLowerCase();
    const hits: SessionSearchPage["hits"] = [];
    for (const session of await this.list()) {
      const record = this.records.get(session.id);
      const file = record ? this.readFile(record) : undefined;
      const matches = (file?.messages ?? []).filter(
        (message) => (message.role === "user" || message.role === "assistant") && message.content.toLowerCase().includes(needle),
      );
      const metadataMatch = session.title.toLowerCase().includes(needle) || (record?.cwd ?? "").toLowerCase().includes(needle);
      if (!metadataMatch && matches.length === 0) continue;
      hits.push({
        session,
        projectName: null,
        metadataMatch,
        messageCount: matches.length,
        matches: matches
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 2)
          .map((message) => ({
            messageId: message.id,
            role: message.role as "user" | "assistant",
            createdAt: message.createdAt,
            snippet: searchExcerpt(message.content, normalized),
          })),
      });
    }
    return { hits, nextOffset: null };
  }

  private record(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error("omp session not found; refresh sessions and try again"), { errorCode: "NOT_FOUND" });
    return record;
  }

  detail(
    id: string,
    options: { messageBefore?: number; messageAround?: string; messageLimit?: number; contentLimit?: number } = {},
  ): SessionDetail | null {
    const record = this.record(id);
    const file = this.readFile(record);
    const all = file?.messages ?? [];
    const limit = Math.max(1, Math.min(options.messageLimit ?? 100, 500));
    const around = options.messageAround?.trim();
    const aroundIndex = around ? all.findIndex((message) => message.id === around) : -1;
    const start = aroundIndex >= 0
      ? Math.max(0, aroundIndex - Math.floor(limit / 2))
      : Math.max(0, Math.min(options.messageBefore ?? all.length, all.length) - limit);
    const end = aroundIndex >= 0 ? Math.min(all.length, start + limit) : Math.min(options.messageBefore ?? all.length, all.length);
    const messages = all.slice(start, end).map((message) => ({
      ...message,
      content: options.contentLimit && message.id !== around ? message.content.slice(0, options.contentLimit) : message.content,
    }));
    return {
      ...this.summary(record, file),
      messageCount: all.length,
      messages,
      messageStart: start,
      ...(aroundIndex >= 0 ? { messageEnd: end, hasMoreAfter: end < all.length } : {}),
    } as SessionDetail;
  }

  fork(_input: { id: string; title?: string; throughMessageId?: string }): SessionDetail {
    throw Object.assign(new Error("Forking omp sessions from the desktop app is not supported yet; use `/fork` in the chat"), {
      errorCode: "OMP_UNSUPPORTED",
    });
  }

  private async runtimeFor(id: string, notify: OmpNotifier): Promise<OmpSessionRuntime> {
    const existing = this.runtimes.get(id);
    if (existing?.alive) return existing;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const record = this.record(id);
    const opening = OmpSessionRuntime.start({
      id,
      cwd: record.cwd,
      sessionPath: record.path && existsSync(record.path) ? record.path : undefined,
      agentDir: this.agentDir,
      notify,
      onSessionFile: (path) => {
        let real = path;
        try { real = realpathSync(path); } catch { /* not written yet */ }
        record.path = real;
        this.pathIds.set(real, id);
      },
      onExit: () => {
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      },
    });
    let runtime: OmpSessionRuntime | undefined;
    this.opening.set(id, opening);
    try {
      runtime = await opening;
      this.runtimes.set(id, runtime);
      return runtime;
    } finally {
      this.opening.delete(id);
    }
  }

  async prompt(id: string, content: string, notify: OmpNotifier, userMessageId?: string): Promise<{ accepted: true; turnId: string }> {
    if (this.runtimes.get(id)?.isRunning) {
      throw Object.assign(new Error("session already has an active turn"), { errorCode: "AGENT_BUSY" });
    }
    const runtime = await this.runtimeFor(id, notify);
    runtime.setNotifier(notify);
    const turnId = randomUUID();
    void runtime.prompt(content, turnId, userMessageId).catch((error) => {
      notify({
        sessionId: id,
        turnId,
        ts: Date.now(),
        event: {
          type: "error",
          error: { code: (error as any)?.errorCode ?? "OMP_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error), retriable: false },
        },
      });
    });
    return { accepted: true, turnId };
  }

  status(id: string): { status: { sessionId: string; isRunning: boolean; pendingToolConfirmations: number; currentTurnId?: string } } {
    const runtime = this.runtimes.get(id);
    return {
      status: {
        sessionId: id,
        isRunning: runtime?.isRunning ?? false,
        ...(runtime?.currentTurnId ? { currentTurnId: runtime.currentTurnId } : {}),
        pendingToolConfirmations: 0,
      },
    };
  }

  async abort(id: string, expectedTurnId?: string): Promise<{ ok: boolean }> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { ok: false };
    return { ok: await runtime.abort(expectedTurnId) };
  }

  dispose(id: string): void {
    this.runtimes.get(id)?.dispose();
    this.runtimes.delete(id);
  }

  disposeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }
}

let shared: OmpSessionService | undefined;
export function ompSessionService(): OmpSessionService {
  shared ??= new OmpSessionService();
  return shared;
}
