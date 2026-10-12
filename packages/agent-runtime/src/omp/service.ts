import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
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
import {
  envModelOverride,
  readOmpPreferences,
  writeOmpPreferences,
  type OmpModelRef,
  type OmpPreferences,
} from "./preferences.js";
import { OmpRpcProcess, type OmpFrame } from "./rpc-process.js";
import { listOmpSessionFiles, parseOmpSession, projectMessage, textOf, type OmpSessionFile } from "./session-store.js";

export type OmpPromptAttachment = { path: string; name?: string; kind: "image" | "file"; mimeType?: string };

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

/** Images become omp `images`; other files become path references omp's tools can read. */
export function prepareOmpPrompt(content: string, attachments: OmpPromptAttachment[] = []): {
  message: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
} {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const files: string[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.path !== "string" || !isAbsolute(attachment.path)) continue;
    const mimeType = attachment.mimeType || IMAGE_MIME[extname(attachment.path).toLowerCase()];
    if (attachment.kind === "image" && mimeType?.startsWith("image/")) {
      const size = statSync(attachment.path).size;
      if (size > MAX_IMAGE_BYTES) throw Object.assign(new Error(`Image is too large (max 20 MB): ${attachment.path}`), { errorCode: "INVALID_ARGUMENT" });
      images.push({ type: "image", data: readFileSync(attachment.path).toString("base64"), mimeType });
    } else if (!content.includes(attachment.path)) {
      files.push(attachment.path);
    }
  }
  const message = files.length
    ? `${content}${content ? "\n\n" : ""}Attached files (read them with your tools):\n${files.map((path) => `- ${path}`).join("\n")}`
    : content;
  return { message, images };
}

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
  /** Model / thinking explicitly chosen in the app for this session. */
  model?: OmpModelRef;
  thinkingLevel?: string;
};

type HiddenPrefs = { hiddenFiles?: string[] };

export type OmpModelInfo = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  input?: string[];
};

export const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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
  private lastPromptUserId?: string;
  onTurnSettled?: (optimisticUserId: string | undefined) => void;
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
    model?: OmpModelRef;
    thinkingLevel?: string;
    agentDir: string;
    notify: OmpNotifier;
    onSessionFile: (path: string) => void;
    onExit: () => void;
  }): Promise<OmpSessionRuntime> {
    const binary = resolveOmpBinary();
    const args = ["--cwd", input.cwd];
    if (input.sessionPath) args.push("--resume", input.sessionPath);
    if (input.model) args.push("--model", `${input.model.provider}/${input.model.modelId}`);
    if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
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

  request<T = any>(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<T> {
    return this.rpc.request<T>(command, timeoutMs);
  }

  /** Rewind the conversation to just before a user message (omp writes a new branch file). */
  async branchBefore(entryId: string): Promise<void> {
    const result = await this.rpc.request<{ cancelled?: boolean }>({ type: "branch", entryId });
    if (result?.cancelled) throw Object.assign(new Error("omp cancelled the branch"), { errorCode: "OMP_BRANCH_CANCELLED" });
    await this.refreshSessionFile();
  }

  async setModel(model: OmpModelRef): Promise<void> {
    await this.rpc.request({ type: "set_model", provider: model.provider, modelId: model.modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.rpc.request({ type: "set_thinking_level", level });
  }

  setNotifier(notify: OmpNotifier): void {
    this.notify = notify;
  }

  async prompt(content: string, turnId: string, userMessageId?: string, images: unknown[] = []): Promise<void> {
    if (this.isRunning) throw Object.assign(new Error("session already has an active turn"), { errorCode: "AGENT_BUSY" });
    this.turnId = turnId;
    this.userMessageId = userMessageId;
    this.lastPromptUserId = userMessageId;
    this.promptRequestId = this.rpc.nextId("prompt");
    this.emit({ type: "agent_start" });
    try {
      const data = await this.rpc.request<{ agentInvoked?: boolean }>({ id: this.promptRequestId, type: "prompt", message: content, ...(images.length ? { images } : {}) });
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
        const optimistic = this.lastPromptUserId;
        this.finish();
        void this.refreshSessionFile()
          .catch(() => undefined)
          .finally(() => this.onTurnSettled?.(optimistic));
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

  private prefsCache?: OmpPreferences;
  private catalog?: { at: number; promise: Promise<{ models: OmpModelInfo[]; defaultModel: OmpModelRef | null }> };

  private prefs(): OmpPreferences {
    this.prefsCache ??= readOmpPreferences();
    return this.prefsCache;
  }

  private savePrefs(update: Partial<OmpPreferences>): void {
    this.prefsCache = { ...this.prefs(), ...update };
    try { writeOmpPreferences(this.prefsCache); } catch { /* preference is best effort */ }
  }

  /** Model a brand-new chat starts with: remembered choice, then env, then omp's default. */
  newSessionModel(): OmpModelRef | undefined {
    return this.prefs().model ?? envModelOverride();
  }

  private modelFields(record: SessionRecord, file: OmpSessionFile | undefined): { providerId?: string; modelId?: string } {
    if (record.model) return { providerId: record.model.provider, modelId: record.model.modelId };
    if (file?.modelId) return { ...(file.providerId ? { providerId: file.providerId } : {}), modelId: file.modelId };
    if (!file) {
      const next = this.newSessionModel();
      if (next) return { providerId: next.provider, modelId: next.modelId };
      const fallback = this.catalogDefault;
      if (fallback) return { providerId: fallback.provider, modelId: fallback.modelId };
    }
    return {};
  }

  private catalogDefault?: OmpModelRef;
  /** Renderer optimistic user-message id -> omp entry id, for edit / regenerate. */
  private readonly aliases = new Map<string, string>();

  private hiddenFiles(): Set<string> {
    return new Set((this.prefs() as HiddenPrefs).hiddenFiles ?? []);
  }

  private hideFile(path: string): void {
    const hidden = this.hiddenFiles();
    hidden.add(path);
    this.savePrefs({ hiddenFiles: [...hidden] } as Partial<OmpPreferences>);
  }

  /** Short-lived omp process bound to a session file, for one-off session commands. */
  private async withSessionProcess<T>(record: SessionRecord, fn: (rpc: OmpRpcProcess) => Promise<T>): Promise<T> {
    if (!record.path || !existsSync(record.path)) {
      throw Object.assign(new Error("This session has no saved conversation yet"), { errorCode: "INVALID_ARGUMENT" });
    }
    const env = { ...process.env };
    if (process.env.PI_DESKTOP_OMP_AGENT_DIR?.trim()) env.PI_CODING_AGENT_DIR = this.agentDir;
    const rpc = new OmpRpcProcess(resolveOmpBinary(), ["--cwd", record.cwd, "--resume", record.path], {
      cwd: existsSync(record.cwd) ? record.cwd : homedir(),
      env,
    });
    try {
      await Promise.race([
        rpc.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("omp did not become ready within 60s")), 60_000)),
      ]);
      return await fn(rpc);
    } finally {
      rpc.dispose();
    }
  }

  private resolveEntryId(record: SessionRecord, messageId: string): string {
    const aliased = this.aliases.get(messageId);
    if (aliased) return aliased;
    const file = this.readFile(record);
    if (file?.messages.some((message) => message.id === messageId)) return messageId;
    throw Object.assign(new Error("That message is not saved in the omp session yet; reopen the chat and try again"), {
      errorCode: "NOT_FOUND",
    });
  }

  async rename(id: string, title: string): Promise<SessionSummary> {
    const name = title.trim();
    if (!name) throw Object.assign(new Error("Session name cannot be empty"), { errorCode: "INVALID_ARGUMENT" });
    const record = this.record(id);
    record.title = name;
    const runtime = this.runtimes.get(id);
    if (runtime?.alive) await runtime.request({ type: "set_session_name", name });
    else if (record.path && existsSync(record.path)) {
      await this.withSessionProcess(record, (rpc) => rpc.request({ type: "set_session_name", name }));
    }
    return this.summary(record, this.readFile(record));
  }

  /** Delete the session file (and omp's per-session artifact folder). The UI confirms first. */
  async delete(id: string): Promise<void> {
    const record = this.record(id);
    if (this.runtimes.get(id)?.isRunning) {
      throw Object.assign(new Error("Stop the running turn before deleting this session"), { errorCode: "AGENT_BUSY" });
    }
    this.dispose(id);
    if (record.path) {
      let root: string;
      try { root = realpathSync(this.root); } catch { root = this.root; }
      if (!inside(root, record.path) || !record.path.endsWith(".jsonl")) {
        throw Object.assign(new Error("Refusing to delete a file outside omp's session folder"), { errorCode: "PERMISSION_DENIED" });
      }
      if (existsSync(record.path)) unlinkSync(record.path);
      const artifacts = record.path.slice(0, -".jsonl".length);
      if (inside(root, artifacts) && artifacts !== root && existsSync(artifacts) && statSync(artifacts).isDirectory()) {
        rmSync(artifacts, { recursive: true, force: true });
      }
      this.pathIds.delete(record.path);
    }
    this.records.delete(id);
  }

  /**
   * omp's own model catalog (models.yml + logins), fetched through a
   * short-lived `omp --mode rpc --no-session` process. Only display fields
   * are returned; nothing secret leaves omp.
   */
  async listModels(options: { refresh?: boolean } = {}): Promise<{
    models: OmpModelInfo[];
    defaultModel: OmpModelRef | null;
    selected: OmpModelRef | null;
    thinkingLevel: string | null;
    thinkingLevels: readonly string[];
  }> {
    const fresh = this.catalog && Date.now() - this.catalog.at < 5 * 60_000 && !options.refresh;
    if (!fresh) {
      const promise = this.fetchCatalog();
      this.catalog = { at: Date.now(), promise };
      promise.catch(() => { if (this.catalog?.promise === promise) this.catalog = undefined; });
    }
    const { models, defaultModel } = await this.catalog!.promise;
    return {
      models,
      defaultModel,
      selected: this.newSessionModel() ?? defaultModel,
      thinkingLevel: this.prefs().thinkingLevel ?? null,
      thinkingLevels: OMP_THINKING_LEVELS,
    };
  }

  private async fetchCatalog(): Promise<{ models: OmpModelInfo[]; defaultModel: OmpModelRef | null }> {
    const binary = resolveOmpBinary();
    const env = { ...process.env };
    if (process.env.PI_DESKTOP_OMP_AGENT_DIR?.trim()) env.PI_CODING_AGENT_DIR = this.agentDir;
    const rpc = new OmpRpcProcess(binary, ["--no-session"], { cwd: homedir(), env });
    try {
      await Promise.race([
        rpc.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("omp did not become ready within 60s")), 60_000)),
      ]);
      const listed = await rpc.request<{ models?: any[] }>({ type: "get_available_models" }, 60_000);
      const state = await rpc.request<{ model?: any }>({ type: "get_state" }).catch(() => undefined);
      const models: OmpModelInfo[] = (listed?.models ?? [])
        .filter((model) => model && typeof model.provider === "string" && typeof model.id === "string")
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          name: typeof model.name === "string" && model.name ? model.name : model.id,
          reasoning: model.reasoning === true,
          ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
          ...(Array.isArray(model.input) ? { input: model.input.filter((value: unknown) => typeof value === "string") } : {}),
        }));
      const current = state?.model;
      const defaultModel = current && typeof current.provider === "string" && typeof current.id === "string"
        ? { provider: current.provider, modelId: current.id }
        : null;
      this.catalogDefault = defaultModel ?? undefined;
      return { models, defaultModel };
    } finally {
      rpc.dispose();
    }
  }

  /** Choose the model for a session (or, without one, for new chats); remembered across restarts. */
  async setModel(input: { sessionId?: string; provider: string; modelId: string }): Promise<SessionSummary | null> {
    const model = { provider: input.provider, modelId: input.modelId };
    this.savePrefs({ model });
    if (!input.sessionId) return null;
    const record = this.record(input.sessionId);
    const runtime = this.runtimes.get(record.id);
    if (runtime?.alive) await runtime.setModel(model);
    record.model = model;
    return this.summary(record, this.readFile(record));
  }

  async setThinkingLevel(input: { sessionId?: string; level: string }): Promise<SessionSummary | null> {
    if (!(OMP_THINKING_LEVELS as readonly string[]).includes(input.level)) {
      throw Object.assign(new Error(`Unsupported thinking level: ${input.level}`), { errorCode: "INVALID_ARGUMENT" });
    }
    this.savePrefs({ thinkingLevel: input.level });
    if (!input.sessionId) return null;
    const record = this.record(input.sessionId);
    const runtime = this.runtimes.get(record.id);
    if (runtime?.alive) await runtime.setThinkingLevel(input.level);
    record.thinkingLevel = input.level;
    return this.summary(record, this.readFile(record));
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
      ...this.modelFields(record, file),
      mode: "agent",
      thinkingLevel: (record.thinkingLevel ?? file?.thinkingLevel ?? (file ? undefined : this.prefs().thinkingLevel) ?? "off") as SessionSummary["thinkingLevel"],
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
    const hidden = this.hiddenFiles();
    if (root) {
      for (const candidate of listOmpSessionFiles(root)) {
        try {
          const path = realpathSync(candidate);
          if (!inside(root, path) || hidden.has(path)) continue;
          const file = parseOmpSession(path);
          if (!file || file.messages.length === 0) continue;
          const id = this.idForPath(path);
          const existing = this.records.get(id);
          const record: SessionRecord = {
            id,
            cwd: file.cwd,
            path,
            createdAt: file.createdAt,
            title: existing?.title,
            model: existing?.model,
            thinkingLevel: existing?.thinkingLevel,
          };
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

  /** Fork with omp's own `fork` command; the original session is untouched. */
  async fork(input: { id: string; title?: string; throughMessageId?: string }): Promise<SessionDetail> {
    const record = this.record(input.id);
    const entryId = input.throughMessageId ? this.resolveEntryId(record, input.throughMessageId) : undefined;
    const newPath = await this.withSessionProcess(record, async (rpc) => {
      const result = await rpc.request<{ cancelled?: boolean }>({ type: "fork", ...(entryId ? { entryId } : {}) });
      if (result?.cancelled) throw Object.assign(new Error("omp cancelled the fork"), { errorCode: "OMP_FORK_CANCELLED" });
      if (input.title?.trim()) await rpc.request({ type: "set_session_name", name: input.title.trim() }).catch(() => undefined);
      const state = await rpc.request<{ sessionFile?: string }>({ type: "get_state" });
      if (!state?.sessionFile) throw new Error("omp did not report the forked session file");
      return state.sessionFile;
    });
    let real = newPath;
    try { real = realpathSync(newPath); } catch { /* keep as reported */ }
    const file = parseOmpSession(real);
    const id = this.idForPath(real);
    const forked: SessionRecord = {
      id,
      cwd: file?.cwd ?? record.cwd,
      path: real,
      createdAt: file?.createdAt ?? new Date().toISOString(),
      title: input.title?.trim() || (file?.title ? undefined : record.title),
    };
    this.records.set(id, forked);
    return this.detail(id)!;
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
      // An explicit choice wins; a fresh chat falls back to the remembered model.
      model: record.model ?? (record.path && existsSync(record.path) ? undefined : this.newSessionModel()),
      thinkingLevel: record.thinkingLevel ?? (record.path && existsSync(record.path) ? undefined : this.prefs().thinkingLevel),
      agentDir: this.agentDir,
      notify,
      onSessionFile: (path) => {
        let real = path;
        try { real = realpathSync(path); } catch { /* not written yet */ }
        // A live process only moves files on `branch` (edit / regenerate):
        // the pre-edit file stays on disk but is no longer this chat.
        if (record.path && record.path !== real) this.hideFile(record.path);
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

  async prompt(
    id: string,
    content: string,
    notify: OmpNotifier,
    userMessageId?: string,
    options: { truncateFromMessageId?: string; attachments?: OmpPromptAttachment[] } = {},
  ): Promise<{ accepted: true; turnId: string }> {
    if (this.runtimes.get(id)?.isRunning) {
      throw Object.assign(new Error("session already has an active turn"), { errorCode: "AGENT_BUSY" });
    }
    const prepared = prepareOmpPrompt(content, options.attachments);
    const record = this.record(id);
    const branchEntry = options.truncateFromMessageId ? this.resolveEntryId(record, options.truncateFromMessageId) : undefined;
    const runtime = await this.runtimeFor(id, notify);
    runtime.setNotifier(notify);
    runtime.onTurnSettled = (optimistic) => {
      // After an edit/regenerate omp re-writes the turn into a new branch file,
      // so the id the transcript still shows must point at the new entry too.
      const keys = [optimistic, options.truncateFromMessageId].filter((key): key is string => Boolean(key));
      if (keys.length === 0) return;
      const users = this.readFile(record)?.messages.filter((message) => message.role === "user") ?? [];
      const last = users.at(-1);
      if (last) for (const key of keys) this.aliases.set(key, last.id);
    };
    if (branchEntry) await runtime.branchBefore(branchEntry);
    const turnId = randomUUID();
    void runtime.prompt(prepared.message, turnId, userMessageId, prepared.images).catch((error) => {
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
export { listOmpRoles, setOmpRole, type OmpRole } from "./roles.js";
