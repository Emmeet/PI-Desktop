import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentActivity,
  AgentEvent,
  AgentEventEnvelope,
  AskToolRequest,
  ContextCompactionMark,
  ContextCompactionReason,
  QueuedTurnSummary,
  SessionTodo,
  ToolPermissionRequest,
  SessionDetail,
  SessionSearchPage,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { NATIVE_PI_SESSION_PREFIX } from "../native-pi-session-id.js";
import { listOmpRoles } from "./roles.js";
import { resolveOmpBinary } from "./binary.js";
import {
  envModelOverride,
  readOmpPreferences,
  writeOmpPreferences,
  type OmpModelRef,
  type OmpPreferences,
} from "./preferences.js";
import { OmpRpcProcess, type OmpFrame } from "./rpc-process.js";
import { commandOutputMessage, recordOmpCommandOutput } from "./command-output-store.js";
import { listOmpSessionFiles, parseOmpSession, projectMessage, textOf, type OmpSessionFile } from "./session-store.js";

export type OmpSubagentView = {
  id: string;
  index: number;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  task?: string;
  description?: string;
  intent?: string;
  currentTool?: string;
  toolCount?: number;
  tokens?: number;
  recentOutput?: string[];
  sessionFile?: string;
  parentToolCallId?: string;
  updatedAt: number;
};

export type OmpSlashCommand = {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  source: string;
};

export type OmpTreeNode = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool" | "system" | "other";
  preview: string;
  timestamp?: string;
  onPath: boolean;
  children: OmpTreeNode[];
};

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
/** Out-of-turn notifications (queue, todos, toasts) for the sidecar to forward. */
export type OmpSideChannel = (method: string, params: unknown) => void;

/** Appended to omp's system prompt while a chat is in desktop plan mode. */
export const OMP_PLAN_MODE_PROMPT = [
  "PLAN MODE is active. Do not modify files, run commands that change state, or make commits.",
  "Investigate with read-only tools only, then write the plan as phases and tasks with the todo tool",
  "and summarize it. Wait for the user to approve the plan before doing any of the work.",
].join(" ");

type OmpTodoPhase = { name?: string; tasks?: Array<{ content?: string; status?: string }> };

/** omp todo phases → the desktop's flat todo list (phase names prefix their tasks). */
export function ompPhasesToTodos(phases: unknown): SessionTodo[] {
  if (!Array.isArray(phases)) return [];
  const todos: SessionTodo[] = [];
  const multi = phases.length > 1;
  for (const phase of phases as OmpTodoPhase[]) {
    for (const task of phase?.tasks ?? []) {
      const content = String(task?.content ?? "").trim();
      if (!content) continue;
      const status = task?.status === "in_progress" || task?.status === "completed"
        ? task.status
        : task?.status === "abandoned"
          ? "cancelled"
          : "pending";
      todos.push({ content: multi && phase?.name ? `${phase.name}: ${content}` : content, status, priority: "medium" });
    }
  }
  return todos;
}

/** Stable queue entry id: the queue kind plus the message text. */
export function ompQueueEntryId(queue: "steering" | "followUp", message: string): string {
  return `ompq:${queue}:${Buffer.from(message, "utf8").toString("base64url")}`;
}

export function parseOmpQueueEntryId(id: string): { queue: "steering" | "followUp"; message: string } | undefined {
  const match = /^ompq:(steering|followUp):(.*)$/.exec(id);
  if (!match) return undefined;
  return { queue: match[1] as "steering" | "followUp", message: Buffer.from(match[2]!, "base64url").toString("utf8") };
}

type PendingUi = {
  method: "permission" | "select" | "confirm" | "input" | "ask";
  questionIds?: string[];
  options?: string[];
  toolName?: string;
  permission?: ToolPermissionRequest;
  ask?: AskToolRequest;
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "search", "lsp", "fetch", "web_search", "todo", "ask"]);

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
  /** Fast mode chosen in the app for this session. */
  fast?: boolean;
};

type HiddenPrefs = { hiddenFiles?: string[] };

export type OmpModelInfo = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  input?: string[];
  /** Levels omp accepts for this model ("off" first); empty when reasoning is not controllable. */
  thinkingLevels: string[];
  /** omp's fast mode (priority service tier) can apply to this model. */
  fast: boolean;
};

/**
 * Mirrors omp's serviceTierFamily()/shouldSendServiceTier("priority") so the
 * UI can tell which models take /fast. omp still decides: set_fast_mode errors
 * for models it rejects.
 */
export function ompModelSupportsFast(model: any): boolean {
  const provider = model?.provider;
  const api = model?.api;
  const identity = model?.identity?.class;
  const openAiApi = api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses";
  const openAiRelay = provider !== "fireworks" && provider !== "github-copilot" && openAiApi && identity === "openai";
  let family: string | undefined;
  if (provider === "openrouter") family = ["anthropic", "gemini", "openai"].includes(identity) ? identity : undefined;
  else if (provider === "openai" || provider === "openai-codex") family = "openai";
  else if (api === "anthropic-messages") family = "anthropic";
  else if (provider === "google" || provider === "google-vertex") family = "google";
  else if (openAiRelay) family = "openai";
  if (!family) return false;
  if (family === "openai" && api === "openai-codex-responses" && Array.isArray(model.serviceTiers) && model.serviceTiers.length > 0) {
    return model.serviceTiers.includes("priority");
  }
  return true;
}

export const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
  private lastPromptText = "";
  onTurnSettled?: (optimisticUserId: string | undefined) => void;
  private currentAssistant?: UiMessage;
  private readonly toolArgs = new Map<string, unknown>();
  private readonly openTools = new Map<string, string>();
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly sessionAllowed = new Set<string>();
  private readonly pendingSteers: Array<{ text: string; optimisticId: string }> = [];
  private queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  private lastMessageId?: string;
  private compactionReason?: ContextCompactionReason;
  side: OmpSideChannel = () => undefined;
  sessionFile?: string;
  private readonly subagents = new Map<string, OmpSubagentView>();
  private commands?: OmpSlashCommand[];

  private constructor(
    readonly id: string,
    readonly planMode: boolean,
    private readonly rpc: OmpRpcProcess,
    private notify: OmpNotifier,
    private readonly onSessionFile: (path: string) => void,
    private readonly onExit: () => void,
  ) {
    rpc.onFrame((frame) => this.onFrame(frame));
    rpc.onExit((reason) => {
      this.clearPendingUi();
      if (this.queue.steering.length || this.queue.followUp.length) this.applyQueue({ steering: [], followUp: [] });
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
    planMode?: boolean;
    side?: OmpSideChannel;
    notify: OmpNotifier;
    onSessionFile: (path: string) => void;
    onExit: () => void;
  }): Promise<OmpSessionRuntime> {
    const binary = resolveOmpBinary();
    const args = ["--cwd", input.cwd];
    // Plan mode: every non-read tool must ask, and the runtime denies those.
    if (input.planMode) args.push("--approval-mode", "always-ask", "--append-system-prompt", OMP_PLAN_MODE_PROMPT);
    if (input.sessionPath) args.push("--resume", input.sessionPath);
    if (input.model) args.push("--model", `${input.model.provider}/${input.model.modelId}`);
    if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
    const env = { ...process.env };
    // Keep the child on the same agent dir the app lists sessions from.
    if (process.env.PI_DESKTOP_OMP_AGENT_DIR?.trim()) env.PI_CODING_AGENT_DIR = input.agentDir;
    const rpc = new OmpRpcProcess(binary, args, { cwd: input.cwd, env, mode: "rpc-ui" });
    const runtime = new OmpSessionRuntime(input.id, input.planMode === true, rpc, input.notify, input.onSessionFile, input.onExit);
    if (input.side) runtime.side = input.side;
    try {
      await Promise.race([
        rpc.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("omp did not become ready within 60s")), 60_000)),
      ]);
      // Route omp's ask tool to the desktop's ask card.
      // omp handles stdin in order, so this lands before the first prompt.
      void rpc.request({ type: "set_ask_dialog", enabled: true }).catch(() => undefined);
      // Live subagent lifecycle + aggregated progress (not every inner event).
      void rpc.request({ type: "set_subagent_subscription", level: "progress" }).catch(() => undefined);
      // Desktop-side tools (screenshot, open file, clipboard) run in the app.
      if (process.env.PI_DESKTOP_OMP_HOST_TOOLS !== "0") {
        void rpc.request({ type: "set_host_tools", tools: OMP_HOST_TOOLS }).catch(() => undefined);
        void rpc.request({ type: "set_host_uri_schemes", schemes: OMP_HOST_URI_SCHEMES }).catch(() => undefined);
      }
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

  /** Keep slash-command output (which omp never writes to the session file) for reloads. */
  private persistCommandOutput(id: string, command: string, output: string, createdAt: string): void {
    if (!command.trim().startsWith("/")) return;
    void this.refreshSessionFile()
      .catch(() => undefined)
      .then(() => {
        if (!this.sessionFile) return;
        const file = parseOmpSession(this.sessionFile, undefined, { commandOutputs: false });
        if (!file) return;
        recordOmpCommandOutput(file.sessionId, { id, anchor: file.messages.at(-1)?.id ?? "", command: command.trim(), output, createdAt });
      })
      .catch(() => undefined);
  }

  sendRaw(frame: Record<string, unknown>): void {
    this.rpc.send(frame);
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
    this.lastPromptText = content;
    this.promptRequestId = this.rpc.nextId("prompt");
    this.emit({ type: "agent_start" });
    this.emitStatus();
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

  /** Interrupt the running turn with a message (delivered at the next turn boundary). */
  async steer(content: string, optimisticId: string | undefined, images: unknown[] = []): Promise<void> {
    if (!this.turnId) throw Object.assign(new Error("No active turn to steer"), { errorCode: "TURN_NOT_FOUND" });
    if (optimisticId) this.pendingSteers.push({ text: content, optimisticId });
    await this.rpc.request({ type: "steer", message: content, ...(images.length ? { images } : {}) });
  }

  /** Queue a message omp sends after the current run finishes. */
  async followUp(content: string): Promise<void> {
    if (!this.turnId) throw Object.assign(new Error("No active turn"), { errorCode: "TURN_NOT_FOUND" });
    await this.rpc.request({ type: "follow_up", message: content });
  }

  queueEntries(): QueuedTurnSummary[] {
    const createdAt = new Date().toISOString();
    const entries: QueuedTurnSummary[] = [];
    for (const queue of ["steering", "followUp"] as const) {
      for (const message of this.queue[queue]) {
        // A steer sent from the composer already shows in the transcript.
        if (queue === "steering" && this.pendingSteers.some((steer) => steer.text === message)) continue;
        entries.push({ id: ompQueueEntryId(queue, message), sessionId: this.id, content: message, position: entries.length, createdAt });
      }
    }
    return entries;
  }

  async removeQueued(entryId: string): Promise<void> {
    const entry = parseOmpQueueEntryId(entryId);
    if (!entry) return;
    await this.rpc.request({ type: "remove_queued_message", message: entry.message, queue: entry.queue });
  }

  async promoteQueued(entryId: string): Promise<void> {
    const entry = parseOmpQueueEntryId(entryId);
    if (!entry || entry.queue !== "followUp") return;
    await this.rpc.request({ type: "promote_queued_message", message: entry.message });
  }

  async compact(throughMessageId?: string): Promise<void> {
    if (throughMessageId && !this.lastMessageId) this.lastMessageId = throughMessageId;
    if (this.turnId) throw Object.assign(new Error("Session already has an active turn"), { errorCode: "AGENT_BUSY" });
    this.compactionReason = "manual";
    this.emit({ type: "compaction_start", reason: "manual" });
    this.emitStatus({ phase: "compacting", since: Date.now(), reason: "manual" });
    try {
      const result = await this.rpc.request<{ tokensBefore?: number; summary?: string }>({ type: "compact" }, 300_000);
      this.emit({
        type: "compaction_end",
        reason: "manual",
        ok: true,
        willRetry: false,
        ...(typeof result?.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
        ...(this.compactionMark() ? { mark: this.compactionMark()! } : {}),
      });
    } catch (error) {
      this.emit({
        type: "compaction_end",
        reason: "manual",
        ok: false,
        willRetry: false,
        error: { code: "OMP_COMPACT_FAILED", message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      this.compactionReason = undefined;
      this.emitStatus();
    }
  }

  subagentList(): OmpSubagentView[] {
    return [...this.subagents.values()].sort((a, b) => a.index - b.index);
  }

  async cancelSubagent(subagentId: string): Promise<boolean> {
    const result = await this.rpc.request<{ cancelled?: boolean }>({ type: "cancel_subagent", subagentId });
    return result?.cancelled === true;
  }

  async steerSubagent(subagentId: string, message: string): Promise<void> {
    await this.rpc.request({ type: "steer_subagent", subagentId, message });
  }

  async availableCommands(): Promise<OmpSlashCommand[]> {
    if (this.commands) return this.commands;
    const result = await this.rpc.request<{ commands?: OmpSlashCommand[] }>({ type: "get_available_commands" });
    this.commands = Array.isArray(result?.commands) ? result.commands : [];
    return this.commands;
  }

  private applySubagent(id: string, patch: Partial<OmpSubagentView> & { index?: number; agent?: string }): void {
    const previous = this.subagents.get(id);
    const next: OmpSubagentView = {
      id,
      index: patch.index ?? previous?.index ?? 0,
      agent: patch.agent ?? previous?.agent ?? "task",
      status: patch.status ?? previous?.status ?? "running",
      ...(previous ?? {}),
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      updatedAt: Date.now(),
    } as OmpSubagentView;
    this.subagents.set(id, next);
    this.side("native.subagents.changed", { sessionId: this.id, subagents: this.subagentList() });
  }

  private onSubagentFrame(frame: OmpFrame): void {
    const payload = frame.payload ?? {};
    if (frame.type === "subagent_lifecycle") {
      const id = String(payload.id ?? "");
      if (!id) return;
      const status = payload.status === "started" ? "running" : String(payload.status ?? "running");
      // omp sometimes aborts a just-spawned subagent and restarts it under a
      // new id ("Name" -> "Name-2") for the same task call; drop the stub.
      if (payload.status === "started" && payload.parentToolCallId) {
        for (const [otherId, other] of this.subagents) {
          if (otherId !== id && other.parentToolCallId === String(payload.parentToolCallId)
            && other.index === (Number(payload.index) || 0) && other.status === "aborted" && !other.toolCount) {
            this.subagents.delete(otherId);
          }
        }
      }
      this.applySubagent(id, {
        index: Number(payload.index) || 0,
        agent: String(payload.agent ?? "task"),
        status: status as OmpSubagentView["status"],
        ...(payload.description ? { description: String(payload.description) } : {}),
        ...(payload.sessionFile ? { sessionFile: String(payload.sessionFile) } : {}),
        ...(payload.parentToolCallId ? { parentToolCallId: String(payload.parentToolCallId) } : {}),
      });
      return;
    }
    const progress = payload.progress ?? {};
    const id = String(progress.id ?? "");
    if (!id) return;
    this.applySubagent(id, {
      index: Number(payload.index ?? progress.index) || 0,
      agent: String(payload.agent ?? progress.agent ?? "task"),
      ...(typeof progress.status === "string" ? { status: progress.status as OmpSubagentView["status"] } : {}),
      task: String(payload.task ?? progress.task ?? ""),
      ...(progress.description ? { description: String(progress.description) } : {}),
      ...(progress.lastIntent ? { intent: String(progress.lastIntent) } : {}),
      currentTool: typeof progress.currentTool === "string" ? progress.currentTool : "",
      toolCount: Number(progress.toolCount) || 0,
      tokens: Number(progress.tokens) || 0,
      ...(Array.isArray(progress.recentOutput) ? { recentOutput: progress.recentOutput.slice(-3).map(String) } : {}),
      ...(payload.sessionFile ? { sessionFile: String(payload.sessionFile) } : {}),
      ...(payload.parentToolCallId ? { parentToolCallId: String(payload.parentToolCallId) } : {}),
    });
  }

  pendingInteractive(): { asks: AskToolRequest[]; permissions: ToolPermissionRequest[] } {
    const asks: AskToolRequest[] = [];
    const permissions: ToolPermissionRequest[] = [];
    for (const pending of this.pendingUi.values()) {
      if (pending.permission) permissions.push(pending.permission);
      if (pending.ask) asks.push(pending.ask);
    }
    return { asks, permissions };
  }

  hasUiRequest(requestId: string): boolean {
    return this.pendingUi.has(requestId);
  }

  /** Answer an omp tool-approval prompt. `allow-session` also approves later calls of the tool in this chat. */
  resolvePermission(requestId: string, decision: string): boolean {
    const pending = this.pendingUi.get(requestId);
    if (!pending || pending.method !== "permission") return false;
    this.pendingUi.delete(requestId);
    const allow = decision === "allow-once" || decision === "allow-session" || decision === "allow-always";
    if (allow && decision !== "allow-once" && pending.toolName) this.sessionAllowed.add(pending.toolName);
    this.respond(requestId, { value: allow ? "Approve" : "Deny" });
    this.emitStatus();
    return true;
  }

  /** Answer an omp dialog shown as an ask card. A `null` answer cancels it. */
  resolveAsk(requestId: string, answers: Array<string[] | null>): boolean {
    const pending = this.pendingUi.get(requestId);
    if (!pending || pending.method === "permission") return false;
    this.pendingUi.delete(requestId);
    const first = answers[0] ?? null;
    if (pending.method === "ask") {
      if (answers.every((answer) => answer === null)) return this.respond(requestId, { cancelled: true }), true;
      const ids = pending.questionIds ?? [];
      const optionSets = pending.ask?.questions.map((question) =>
        new Set(question.options.map((option) => (typeof option === "string" ? option : option.label)))) ?? [];
      this.respond(requestId, {
        answers: ids.map((id, index) => {
          const picked = answers[index] ?? [];
          const selected = picked.filter((value) => optionSets[index]?.has(value));
          const custom = picked.filter((value) => !optionSets[index]?.has(value)).join("\n");
          return { id, selectedOptions: selected, ...(custom ? { customInput: custom } : {}) };
        }),
      });
      return true;
    }
    if (first === null) return this.respond(requestId, { cancelled: true }), true;
    if (pending.method === "confirm") this.respond(requestId, { confirmed: first[0] === "Yes" });
    else this.respond(requestId, { value: first.join("\n") });
    return true;
  }

  private respond(id: string, payload: Record<string, unknown>): void {
    try { this.rpc.send({ type: "extension_ui_response", id, ...payload }); } catch { /* process gone */ }
  }

  private clearPendingUi(): void {
    this.pendingUi.clear();
  }

  private toolCallFor(toolName: string): string | undefined {
    let found: string | undefined;
    for (const [toolCallId, name] of this.openTools) if (name === toolName) found = toolCallId;
    return found;
  }

  private onUiRequest(frame: OmpFrame): void {
    const id = String(frame.id ?? "");
    const method = String(frame.method ?? "");
    if (method === "cancel") {
      const target = String(frame.targetId ?? "");
      if (this.pendingUi.delete(target)) this.side("native.ui.cancelled", { sessionId: this.id, requestId: target });
      return;
    }
    if (method === "notify") {
      const message = String(frame.message ?? "").trim();
      if (message) this.side("native.notice", { sessionId: this.id, level: frame.notifyType ?? "info", message });
      return;
    }
    if (!id) return;
    const title = String(frame.title ?? "");
    if (method === "select") {
      const options = Array.isArray(frame.options) ? frame.options.map(String) : [];
      const approval = /^Allow tool: ([^\n]+)/.exec(title);
      if (approval && options.includes("Approve") && options.includes("Deny")) {
        const toolName = approval[1]!.trim();
        if (this.planMode && !READ_ONLY_TOOLS.has(toolName)) return this.respond(id, { value: "Deny" });
        if (this.sessionAllowed.has(toolName)) return this.respond(id, { value: "Approve" });
        const toolCallId = this.toolCallFor(toolName) ?? `omp-approval:${id}`;
        const permission: ToolPermissionRequest = {
          requestId: id,
          sessionId: this.id,
          toolCallId,
          toolName,
          argsPreview: this.toolArgs.get(toolCallId) ?? {},
          risk: toolName === "bash" || toolName === "python" ? "high" : "medium",
          reason: title.split("\n").slice(1).join("\n").trim(),
        };
        this.pendingUi.set(id, { method: "permission", toolName, permission });
        this.emit({ type: "tool_permission_request", request: permission });
        this.emitStatus();
        return;
      }
      return this.showAsk(id, "select", [{ question: title, options, multiSelect: false }]);
    }
    if (method === "confirm") {
      const message = String(frame.message ?? "").trim();
      return this.showAsk(id, "confirm", [{ question: message ? `${title}\n${message}` : title, options: ["Yes", "No"], multiSelect: false }]);
    }
    if (method === "input" || method === "editor") {
      const placeholder = String(frame.placeholder ?? frame.prefill ?? "").trim();
      return this.showAsk(id, "input", [{ question: placeholder ? `${title}\n${placeholder}` : title, options: [], multiSelect: false }]);
    }
    if (method === "ask") {
      const questions = Array.isArray(frame.questions) ? frame.questions : [];
      return this.showAsk(
        id,
        "ask",
        questions.map((question: any) => ({
          question: String(question?.question ?? question?.header ?? ""),
          options: (Array.isArray(question?.options) ? question.options : []).map((option: any) =>
            typeof option === "string"
              ? option
              : { label: String(option?.label ?? ""), ...(option?.description ? { description: String(option.description) } : {}) }),
          multiSelect: question?.multi === true,
        })),
        questions.map((question: any) => String(question?.id ?? "")),
      );
    }
    // setStatus / setWidget / setTitle / set_editor_text are TUI chrome: ignore.
  }

  private showAsk(id: string, method: PendingUi["method"], questions: AskToolRequest["questions"], questionIds?: string[]): void {
    const ask: AskToolRequest = {
      requestId: id,
      sessionId: this.id,
      toolCallId: this.toolCallFor("ask") ?? `omp-ui:${id}`,
      questions,
    };
    this.pendingUi.set(id, { method, ask, ...(questionIds ? { questionIds } : {}) });
    this.emit({ type: "asktool_request", request: ask });
  }

  private applyQueue(queue: { steering: string[]; followUp: string[] }): void {
    this.queue = queue;
    this.side("native.queue.changed", { sessionId: this.id, entries: this.queueEntries() });
  }

  private emitTodos(todos: SessionTodo[]): void {
    this.side("native.todos.changed", { sessionId: this.id, todos });
  }

  private compactionMark(): ContextCompactionMark | undefined {
    const through = this.lastMessageId;
    if (!through) return undefined;
    return { id: `omp-compaction:${randomUUID()}`, throughMessageId: through, summarized: true, generation: 1, summaryTokens: 0 };
  }

  private emitStatus(activity?: AgentActivity): void {
    let pending = 0;
    for (const entry of this.pendingUi.values()) if (entry.method === "permission") pending += 1;
    this.emit({
      type: "status",
      status: {
        sessionId: this.id,
        isRunning: this.turnId !== undefined,
        ...(this.turnId ? { currentTurnId: this.turnId } : {}),
        pendingToolConfirmations: pending,
        ...(activity ? { activity } : {}),
      },
    });
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
    this.clearPendingUi();
    this.openTools.clear();
    this.pendingSteers.length = 0;
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
        } else if (frame.id === this.promptRequestId && frame.success === true && frame.data?.agentInvoked === false) {
          // A slash command omp ran locally: no agent turn and no prompt_result follows.
          this.finish();
        }
        return;
      }
      case "command_output": {
        const text = stripAnsi(String(frame.text ?? "")).trimEnd();
        if (!text) return;
        if (!this.turnId) {
          this.side("native.notice", { sessionId: this.id, level: "info", message: text.slice(0, 400) });
          return;
        }
        const recordId = randomUUID();
        const createdAt = new Date().toISOString();
        this.emit({ type: "message_end", message: commandOutputMessage(`omp-command:${recordId}`, text, createdAt) });
        this.persistCommandOutput(recordId, this.lastPromptText, text, createdAt);
        return;
      }
      case "extension_ui_request":
        this.onUiRequest(frame);
        return;
      case "queue_update":
        this.applyQueue({
          steering: Array.isArray(frame.steering) ? frame.steering.map(String) : [],
          followUp: Array.isArray(frame.followUp) ? frame.followUp.map(String) : [],
        });
        return;
      case "auto_compaction_start": {
        // Out of a turn (omp's idle compaction) it behaves like a manual one:
        // the UI shows it as busy and clears that when it ends.
        const reason: ContextCompactionReason = !this.turnId ? "manual" : frame.reason === "overflow" ? "overflow" : "threshold";
        this.compactionReason = reason;
        this.emit({ type: "compaction_start", reason });
        this.emitStatus({ phase: "compacting", since: Date.now(), reason });
        return;
      }
      case "auto_compaction_end": {
        const reason = this.compactionReason ?? "threshold";
        this.compactionReason = undefined;
        const ok = !frame.aborted && !frame.errorMessage && !frame.skipped && Boolean(frame.result);
        const mark = ok ? this.compactionMark() : undefined;
        this.emit({
          type: "compaction_end",
          reason,
          ok,
          willRetry: frame.willRetry === true,
          ...(typeof frame.result?.tokensBefore === "number" ? { tokensBefore: frame.result.tokensBefore } : {}),
          ...(mark ? { mark } : {}),
          ...(frame.errorMessage ? { error: { code: "OMP_COMPACTION_FAILED", message: String(frame.errorMessage) } } : {}),
        });
        this.emitStatus();
        return;
      }
      case "auto_retry_start":
        this.emitStatus({
          phase: "retrying",
          since: Date.now(),
          attempt: Number(frame.attempt) || 1,
          ...(Number(frame.delayMs) ? { retryDelayMs: Number(frame.delayMs) } : {}),
          ...(frame.errorMessage ? { error: { code: "OMP_RETRY", message: String(frame.errorMessage) } } : {}),
        });
        return;
      case "auto_retry_end":
        this.emitStatus();
        if (frame.success === false && frame.finalError) {
          this.side("native.notice", { sessionId: this.id, level: "error", message: String(frame.finalError) });
        }
        return;
      case "retry_fallback_applied":
        this.side("native.notice", { sessionId: this.id, level: "warning", message: `Model fallback: ${String(frame.from ?? "")} → ${String(frame.to ?? "")}` });
        return;
      case "notice":
        if (frame.message) this.side("native.notice", { sessionId: this.id, level: frame.level ?? "info", message: String(frame.message) });
        return;
      case "todo_auto_clear":
        this.emitTodos([]);
        return;
      case "subagent_lifecycle":
      case "subagent_progress":
        this.onSubagentFrame(frame);
        return;
      case "available_commands_update":
        this.commands = Array.isArray(frame.commands) ? frame.commands : [];
        this.side("native.commands.changed", { sessionId: this.id });
        return;
      case "btw_delta":
      case "btw_record":
        this.side("native.btw", { sessionId: this.id, frame });
        return;
      case "host_tool_call":
      case "host_tool_cancel":
      case "host_uri_request":
      case "host_uri_cancel":
        this.side("native.host.request", { sessionId: this.id, frame });
        return;
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
          const text = textOf(message.content).text.trim();
          const steerIndex = this.userMessageId ? -1 : this.pendingSteers.findIndex((steer) => steer.text.trim() === text);
          const steer = steerIndex >= 0 ? this.pendingSteers.splice(steerIndex, 1)[0] : undefined;
          const optimistic = this.userMessageId ?? steer?.optimisticId;
          const projected = projectMessage(optimistic ?? id, new Date().toISOString(), message);
          if (!projected) return;
          this.lastMessageId = projected.id;
          if (optimistic) {
            this.emit({
              type: "user_message_persisted",
              optimisticMessageId: optimistic,
              message: steer || message.steering ? { ...projected, steering: true } : projected,
            });
            this.userMessageId = undefined;
          } else {
            // A queued follow-up or steer typed elsewhere: show it as it lands.
            this.emit({ type: "message_end", message: message.steering ? { ...projected, steering: true } : projected });
          }
          return;
        }
        if (message?.role === "assistant") {
          const live = this.currentAssistant;
          const projected = projectMessage(live?.id ?? id, live?.createdAt ?? new Date().toISOString(), message, this.toolArgs);
          this.currentAssistant = undefined;
          if (projected) this.lastMessageId = projected.id;
          if (projected) this.emit({ type: "message_end", message: projected, ...(live ? { replacesMessageId: live.id } : {}) });
          return;
        }
        // toolResult messages are already represented live by tool_start /
        // tool_end; re-emitting them would render each tool call twice.
        return;
      }
      case "tool_execution_start":
        this.toolArgs.set(frame.toolCallId, frame.args);
        this.openTools.set(frame.toolCallId, frame.toolName);
        this.emit({ type: "tool_start", toolCallId: frame.toolCallId, toolName: frame.toolName, args: frame.args });
        return;
      case "tool_execution_update":
        this.emit({ type: "tool_update", toolCallId: frame.toolCallId, partialResult: frame.partialResult });
        return;
      case "tool_execution_end":
        this.openTools.delete(frame.toolCallId);
        this.emit({ type: "tool_end", toolCallId: frame.toolCallId, result: frame.result, isError: frame.isError === true });
        if (frame.toolName === "todo" && frame.isError !== true) {
          const details = frame.result?.details;
          if (details && details.op !== "view" && Array.isArray(details.phases)) this.emitTodos(ompPhasesToTodos(details.phases));
        }
        return;
    }
  }
}

/**
 * omp-backed session service. Lists and reads omp's own session files and
 * drives each conversation through a dedicated `omp --mode rpc` process.
 * omp handles models (models.yml), credentials, tools, and persistence.
 */
/** Tools the desktop app executes for omp (`set_host_tools`); see main's omp-host-tools. */
export const OMP_HOST_TOOLS = [
  {
    name: "desktop_screenshot",
    label: "Desktop screenshot",
    description: "Capture a screenshot of the user's screen (primary display) and return it as an image.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "desktop_open",
    label: "Open in desktop app",
    description: "Open a file, folder or http(s) URL with the user's default desktop application.",
    parameters: { type: "object", properties: { target: { type: "string", description: "Absolute path or http(s) URL" } }, required: ["target"], additionalProperties: false },
  },
  {
    name: "desktop_clipboard_read",
    label: "Read clipboard",
    description: "Read the text currently on the user's clipboard.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "desktop_clipboard_write",
    label: "Write clipboard",
    description: "Put text on the user's clipboard.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
];
export const OMP_HOST_URI_SCHEMES = [
  { scheme: "clipboard", description: "The desktop clipboard as text (clipboard://text)", writable: true },
];

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

  /** omp's `default` role (modelRoles.default), cached; new chats start with it. */
  private defaultRole?: { model: OmpModelRef; thinking?: string } | null;
  /** A model / level picked in the new-chat composer before the chat exists. */
  private pendingNew?: { model?: OmpModelRef; thinking?: string };

  async refreshDefaultRole(): Promise<void> {
    try {
      const role = (await listOmpRoles()).find((entry) => entry.id === "default");
      const value = role?.model ?? null;
      if (!value) { this.defaultRole = null; return; }
      const suffix = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(value);
      const ref = suffix ? value.slice(0, suffix.index) : value;
      const slash = ref.indexOf("/");
      this.defaultRole = slash > 0
        ? { model: { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }, ...(suffix ? { thinking: suffix[1] === "max" ? "xhigh" : suffix[1] } : {}) }
        : null;
    } catch {
      /* keep the last known default */
    }
  }

  /** Model a brand-new chat starts with: a draft pick, then omp's `default` role, then env, then omp's own default. */
  newSessionModel(): OmpModelRef | undefined {
    return this.pendingNew?.model ?? this.defaultRole?.model ?? envModelOverride();
  }

  newSessionThinking(): string | undefined {
    return this.pendingNew?.thinking ?? this.defaultRole?.thinking ?? (this.defaultRole ? undefined : this.prefs().thinkingLevel);
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

  /** Fork point: a message on the shown branch, or any entry of the file's tree (branch view). */
  private resolveForkEntry(record: SessionRecord, messageId: string): string {
    try {
      return this.resolveEntryId(record, messageId);
    } catch (error) {
      if (record.path && existsSync(record.path) && readFileSync(record.path, "utf8").includes(`"id":${JSON.stringify(messageId)}`)) {
        return messageId;
      }
      throw error;
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
    await this.refreshDefaultRole();
    return {
      models,
      defaultModel,
      selected: this.newSessionModel() ?? defaultModel,
      thinkingLevel: this.newSessionThinking() ?? null,
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
          fast: ompModelSupportsFast(model),
          thinkingLevels: model.reasoning === true && Array.isArray(model.thinking?.efforts) && model.thinking.efforts.length > 0
            ? ["off", ...model.thinking.efforts.filter((e: unknown): e is string => typeof e === "string" && (OMP_THINKING_LEVELS as readonly string[]).includes(e))]
            : [],
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
  async setModel(input: { sessionId?: string; provider: string; modelId: string; persist?: boolean }): Promise<SessionSummary | null> {
    // Role values look like "provider/model:high"; the level is not part of the model id.
    const suffix = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(input.modelId);
    const model = { provider: input.provider, modelId: suffix ? input.modelId.slice(0, suffix.index) : input.modelId };
    // Scheduled runs pin a model per session without changing the user's default.
    if (input.persist !== false || !input.sessionId) this.savePrefs({ model });
    if (!input.sessionId) { this.pendingNew = { ...this.pendingNew, model }; return null; }
    const record = this.record(input.sessionId);
    const runtime = this.runtimes.get(record.id);
    if (runtime?.alive) await runtime.setModel(model);
    record.model = model;
    return this.summary(record, this.readFile(record));
  }

  /** Current fast-mode choice for a session (or, without one, for new chats). */
  fastState(sessionId?: string): { enabled: boolean } {
    if (!sessionId) return { enabled: this.prefs().fast === true };
    const record = this.record(sessionId);
    if (record.fast !== undefined) return { enabled: record.fast };
    const file = this.readFile(record);
    if (file) return { enabled: file.fast === true };
    return { enabled: this.prefs().fast === true };
  }

  /** Toggle omp fast mode (`set_fast_mode`); remembered for new chats. */
  async setFast(input: { sessionId?: string; enabled: boolean }): Promise<{ enabled: boolean; active?: boolean }> {
    let result: { enabled: boolean; active?: boolean } = { enabled: input.enabled };
    if (input.sessionId) {
      const record = this.record(input.sessionId);
      const runtime = this.runtimes.get(record.id);
      if (runtime?.alive) {
        const reply = await runtime.request<{ enabled?: boolean; active?: boolean }>({ type: "set_fast_mode", enabled: input.enabled });
        result = { enabled: reply?.enabled ?? input.enabled, ...(typeof reply?.active === "boolean" ? { active: reply.active } : {}) };
      }
      record.fast = result.enabled;
    }
    this.savePrefs({ fast: input.enabled });
    return result;
  }

  async setThinkingLevel(input: { sessionId?: string; level: string; persist?: boolean }): Promise<SessionSummary | null> {
    if (!(OMP_THINKING_LEVELS as readonly string[]).includes(input.level)) {
      throw Object.assign(new Error(`Unsupported thinking level: ${input.level}`), { errorCode: "INVALID_ARGUMENT" });
    }
    if (input.persist !== false || !input.sessionId) this.savePrefs({ thinkingLevel: input.level });
    if (!input.sessionId) { this.pendingNew = { ...this.pendingNew, thinking: input.level }; return null; }
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
    // A pick made in the empty composer belongs to this chat only; otherwise omp's `default` role applies.
    if (this.pendingNew?.model) record.model = this.pendingNew.model;
    if (this.pendingNew?.thinking) record.thinkingLevel = this.pendingNew.thinking;
    this.pendingNew = undefined;
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
      thinkingLevel: (record.thinkingLevel ?? file?.thinkingLevel ?? (file ? undefined : this.newSessionThinking()) ?? "off") as SessionSummary["thinkingLevel"],
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
      ...(file?.compactions.length ? { compactions: file.compactions, compaction: file.compactions.at(-1) } : {}),
    } as SessionDetail;
  }

  /** Fork with omp's own `fork` command; the original session is untouched. */
  async fork(input: { id: string; title?: string; throughMessageId?: string }): Promise<SessionDetail> {
    const record = this.record(input.id);
    const entryId = input.throughMessageId ? this.resolveForkEntry(record, input.throughMessageId) : undefined;
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
    if (!(record.path && existsSync(record.path)) && !record.model) await this.refreshDefaultRole();
    const opening = OmpSessionRuntime.start({
      id,
      cwd: record.cwd,
      sessionPath: record.path && existsSync(record.path) ? record.path : undefined,
      // An explicit choice wins; a fresh chat falls back to the remembered model.
      model: record.model ?? (record.path && existsSync(record.path) ? undefined : this.newSessionModel()),
      thinkingLevel: record.thinkingLevel ?? (record.path && existsSync(record.path) ? undefined : this.newSessionThinking()),
      agentDir: this.agentDir,
      planMode: this.planModes.has(id),
      side: (method, params) => this.side(method, params),
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
    const fresh = !(record.path && existsSync(record.path));
    try {
      runtime = await opening;
      this.runtimes.set(id, runtime);
      // A new chat inherits the remembered fast-mode choice (omp has no CLI flag for it).
      const wantFast = record.fast ?? (fresh ? this.prefs().fast : undefined);
      // omp handles stdin commands in order, so this lands before the first prompt.
      if (wantFast !== undefined) void runtime.request({ type: "set_fast_mode", enabled: wantFast }).catch(() => undefined);
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
        pendingToolConfirmations: runtime?.pendingInteractive().permissions.length ?? 0,
      },
    };
  }

  private side: OmpSideChannel = () => undefined;

  /** Where queue / todo / notice updates go (the sidecar forwards them to main). */
  setSideChannel(side: OmpSideChannel): void {
    this.side = side;
    for (const runtime of this.runtimes.values()) runtime.side = side;
  }

  private liveRuntime(id: string): OmpSessionRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime?.alive || !runtime.isRunning) {
      throw Object.assign(new Error("No active turn"), { errorCode: "TURN_NOT_FOUND" });
    }
    return runtime;
  }

  async steer(id: string, content: string, optimisticId?: string, attachments: OmpPromptAttachment[] = []): Promise<{ accepted: true; turnId: string }> {
    const runtime = this.liveRuntime(id);
    const prepared = prepareOmpPrompt(content, attachments);
    await runtime.steer(prepared.message, optimisticId, prepared.images);
    return { accepted: true, turnId: runtime.currentTurnId! };
  }

  async followUp(id: string, content: string, attachments: OmpPromptAttachment[] = []): Promise<{ entry: QueuedTurnSummary }> {
    const runtime = this.liveRuntime(id);
    const message = prepareOmpPrompt(content, attachments).message;
    await runtime.followUp(message);
    const entryId = ompQueueEntryId("followUp", message);
    const entries = runtime.queueEntries();
    return {
      entry: entries.find((entry) => entry.id === entryId) ?? {
        id: entryId, sessionId: id, content: message, position: entries.length, createdAt: new Date().toISOString(),
      },
    };
  }

  queueList(id: string): QueuedTurnSummary[] {
    return this.runtimes.get(id)?.queueEntries() ?? [];
  }

  private queueOwner(entryId: string): OmpSessionRuntime | undefined {
    for (const runtime of this.runtimes.values()) {
      if (runtime.queueEntries().some((entry) => entry.id === entryId)) return runtime;
    }
    return undefined;
  }

  async queueRemove(entryId: string): Promise<void> {
    await this.queueOwner(entryId)?.removeQueued(entryId);
  }

  async queuePromote(entryId: string): Promise<void> {
    await this.queueOwner(entryId)?.promoteQueued(entryId);
  }

  /** Manual compaction (omp `compact`), outside a running turn. */
  async compact(id: string, notify: OmpNotifier): Promise<{ accepted: true }> {
    const record = this.record(id);
    if (!(record.path && existsSync(record.path))) {
      throw Object.assign(new Error("Nothing to compact yet"), { errorCode: "INVALID_ARGUMENT" });
    }
    const runtime = await this.runtimeFor(id, notify);
    runtime.setNotifier(notify);
    const last = this.readFile(record)?.messages.at(-1)?.id;
    await runtime.compact(last);
    return { accepted: true };
  }

  /** Every open approval / dialog of one chat (a reloaded window rebuilds its cards). */
  pendingInteractive(id: string): { asks: AskToolRequest[]; permissions: ToolPermissionRequest[] } {
    return this.runtimes.get(id)?.pendingInteractive() ?? { asks: [], permissions: [] };
  }

  resolvePermission(id: string | undefined, requestId: string, decision: string): boolean {
    for (const [sessionId, runtime] of this.runtimes) {
      if (id && sessionId !== id) continue;
      if (runtime.resolvePermission(requestId, decision)) return true;
    }
    return false;
  }

  resolveAsk(id: string, requestId: string, answers: Array<string[] | null>): boolean {
    return this.runtimes.get(id)?.resolveAsk(requestId, answers) ?? false;
  }

  hasUiRequest(requestId: string): boolean {
    for (const runtime of this.runtimes.values()) if (runtime.hasUiRequest(requestId)) return true;
    return false;
  }

  /** The chat's current omp todo list: live state, else the last todo result in its file. */
  async todos(id: string): Promise<SessionTodo[]> {
    const runtime = this.runtimes.get(id);
    if (runtime?.alive) {
      const state = await runtime.request<{ todoPhases?: unknown }>({ type: "get_state" }).catch(() => undefined);
      if (state) return ompPhasesToTodos(state.todoPhases);
    }
    const record = this.records.get(id);
    if (!record?.path || !existsSync(record.path)) return [];
    let phases: unknown = [];
    for (const line of readFileSync(record.path, "utf8").split("\n")) {
      if (!line.includes('"todo"')) continue;
      try {
        const message = JSON.parse(line)?.message;
        if (message?.role === "toolResult" && message.toolName === "todo" && !message.isError && Array.isArray(message.details?.phases)) {
          phases = message.details.phases;
        }
      } catch { /* partial line */ }
    }
    return ompPhasesToTodos(phases);
  }

  /** Replace the todo list (an empty list clears it). Needs the chat's omp process. */
  async setTodos(id: string, todos: SessionTodo[], notify: OmpNotifier): Promise<SessionTodo[]> {
    const runtime = await this.runtimeFor(id, notify);
    const phases = todos.length
      ? [{
          name: "Tasks",
          tasks: todos.map((todo) => ({
            content: todo.content,
            status: todo.status === "cancelled" ? "abandoned" : todo.status,
          })),
        }]
      : [];
    const result = await runtime.request<{ todoPhases?: unknown }>({ type: "set_todos", phases });
    const next = ompPhasesToTodos(result?.todoPhases ?? phases);
    this.side("native.todos.changed", { sessionId: id, todos: next });
    return next;
  }

  // ---- Subagents -------------------------------------------------------
  subagents(id: string): OmpSubagentView[] {
    return this.runtimes.get(id)?.subagentList() ?? [];
  }

  /** Subagents outlive the parent turn (async task), so only the process must be alive. */
  private subagentRuntime(id: string): OmpSessionRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime?.alive) throw Object.assign(new Error("This omp session is not running"), { errorCode: "TURN_NOT_FOUND" });
    return runtime;
  }

  async cancelSubagent(id: string, subagentId: string): Promise<boolean> {
    return this.subagentRuntime(id).cancelSubagent(subagentId);
  }

  async steerSubagent(id: string, subagentId: string, message: string): Promise<void> {
    if (!message.trim()) throw Object.assign(new Error("Message is empty"), { errorCode: "INVALID_ARGUMENT" });
    await this.subagentRuntime(id).steerSubagent(subagentId, message.trim());
  }

  /** A subagent's own transcript: live from omp, else from its session file. */
  async subagentMessages(id: string, subagentId: string, sessionFile?: string): Promise<UiMessage[]> {
    const runtime = this.runtimes.get(id);
    let raw: any[] | undefined;
    if (runtime?.alive) {
      const result = await runtime
        .request<{ messages?: any[] }>({ type: "get_subagent_messages", subagentId, ...(sessionFile ? { sessionFile } : {}) })
        .catch(() => undefined);
      raw = result?.messages;
    }
    if (raw) {
      const args = new Map<string, unknown>();
      return raw.flatMap((message, index) => {
        const projected = projectMessage(`${subagentId}:${index}`, new Date().toISOString(), message, args);
        return projected ? [projected] : [];
      });
    }
    const known = runtime?.subagentList().find((agent) => agent.id === subagentId)?.sessionFile;
    const file = sessionFile ?? known;
    if (!file || !existsSync(file)) {
      throw Object.assign(new Error("This subagent's transcript is not available"), { errorCode: "NOT_FOUND" });
    }
    return parseOmpSession(file)?.messages ?? [];
  }

  // ---- Slash commands ----------------------------------------------------
  /** omp's slash commands (builtins that work over RPC, skills, prompt templates, extensions). */
  async availableCommands(input: { sessionId?: string; cwd?: string }): Promise<OmpSlashCommand[]> {
    const runtime = input.sessionId ? this.runtimes.get(input.sessionId) : undefined;
    if (runtime?.alive) return runtime.availableCommands();
    const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : homedir();
    const cached = this.commandCache.get(cwd);
    if (cached && Date.now() - cached.at < 60_000) return cached.commands;
    const result = await this.utility(cwd).request<{ commands?: OmpSlashCommand[] }>({ type: "get_available_commands" });
    const commands = Array.isArray(result?.commands) ? result.commands : [];
    this.commandCache.set(cwd, { at: Date.now(), commands });
    return commands;
  }

  private readonly commandCache = new Map<string, { at: number; commands: OmpSlashCommand[] }>();

  // ---- Session tree / stats ---------------------------------------------
  private async sessionRequest<T>(id: string, command: Record<string, unknown> & { type: string }): Promise<T> {
    const runtime = this.runtimes.get(id);
    if (runtime?.alive) return runtime.request<T>(command);
    return this.withSessionProcess(this.record(id), (rpc) => rpc.request<T>(command));
  }

  async tree(id: string): Promise<{ nodes: OmpTreeNode[]; leafId: string | null }> {
    const result = await this.sessionRequest<{ tree?: any[]; leafId?: string | null }>(id, { type: "get_tree" });
    const leafId = result?.leafId ?? null;
    const raw = Array.isArray(result?.tree) ? result.tree : [];
    const parents = new Map<string, string | null>();
    const walk = (node: any) => {
      parents.set(String(node?.entry?.id ?? ""), node?.entry?.parentId ?? null);
      for (const child of node?.children ?? []) walk(child);
    };
    raw.forEach(walk);
    const onPath = new Set<string>();
    for (let at: string | null | undefined = leafId; at; at = parents.get(at)) onPath.add(at);
    return { nodes: raw.flatMap((node) => ompTreeNodes(node, null, onPath)), leafId };
  }

  async sessionStats(id: string): Promise<Record<string, unknown>> {
    return this.sessionRequest<Record<string, unknown>>(id, { type: "get_session_stats" });
  }

  /** The app's answer to a host tool / URI request (see `native.host.request`). */
  hostRespond(id: string, frame: Record<string, unknown> & { type: string }): void {
    if (!["host_tool_result", "host_tool_update", "host_uri_result"].includes(frame.type)) {
      throw Object.assign(new Error(`not a host reply: ${frame.type}`), { errorCode: "INVALID_ARGUMENT" });
    }
    const runtime = this.runtimes.get(id);
    if (!runtime?.alive) return;
    runtime.sendRaw(frame);
  }

  /** omp RPC commands the desktop drives directly for one session (or the utility process). */
  static readonly SESSION_COMMANDS = new Set([
    "export_html", "goal", "handoff", "btw", "btw_cancel", "get_btw_history",
    "set_slow_mode", "set_cache_warming", "predict_word", "predict_word_feedback",
  ]);

  async sessionCommand(id: string | undefined, command: Record<string, unknown> & { type: string }): Promise<unknown> {
    if (!OmpSessionService.SESSION_COMMANDS.has(command.type)) {
      throw Object.assign(new Error(`omp command not allowed: ${command.type}`), { errorCode: "INVALID_ARGUMENT" });
    }
    // Word prediction is local (n-gram) and needs no chat.
    if (!id || command.type === "predict_word" || command.type === "predict_word_feedback") {
      return (await this.utilityReady()).request(command, 30_000);
    }
    if (command.type === "handoff" && this.runtimes.get(id)?.isRunning) {
      throw Object.assign(new Error("Cannot hand off while a response is in progress"), { errorCode: "AGENT_BUSY" });
    }
    const long = command.type === "handoff" || command.type === "btw" || command.type === "export_html";
    const runtime = this.runtimes.get(id);
    if (runtime?.alive) return runtime.request(command, long ? 10 * 60_000 : 60_000);
    return this.withSessionProcess(this.record(id), (rpc) => rpc.request(command, long ? 10 * 60_000 : 60_000));
  }

  // ---- Utility process (login, commands without a chat) ------------------
  private utilityProcess?: { rpc: OmpRpcProcess; cwd: string; timer?: NodeJS.Timeout };
  private readonly loginUi = new Map<string, string>();

  private utility(cwd = homedir()): OmpRpcProcess {
    const current = this.utilityProcess;
    if (current?.rpc.isAlive && current.cwd === cwd) {
      this.touchUtility();
      return current.rpc;
    }
    current?.rpc.dispose();
    const env = { ...process.env };
    if (process.env.PI_DESKTOP_OMP_AGENT_DIR?.trim()) env.PI_CODING_AGENT_DIR = this.agentDir;
    const rpc = new OmpRpcProcess(resolveOmpBinary(), ["--cwd", cwd, "--no-session", "--no-title"], { cwd, env, mode: "rpc-ui" });
    rpc.onFrame((frame) => {
      if (frame.type !== "extension_ui_request") return;
      const requestId = String(frame.id ?? "");
      if (frame.method === "open_url") {
        this.side("native.login.ui", { kind: "open_url", url: String(frame.url ?? ""), ...(frame.instructions ? { instructions: String(frame.instructions) } : {}) });
      } else if (frame.method === "notify") {
        this.side("native.login.ui", { kind: "progress", message: String(frame.message ?? "") });
      } else if (frame.method === "input" || frame.method === "editor") {
        this.loginUi.set(requestId, String(frame.method));
        this.side("native.login.ui", { kind: "input", requestId, title: String(frame.title ?? ""), ...(frame.placeholder ? { placeholder: String(frame.placeholder) } : {}) });
      } else if (frame.method === "select" || frame.method === "confirm") {
        // Login never needs these; answer so omp does not wait forever.
        try { rpc.send({ type: "extension_ui_response", id: requestId, cancelled: true }); } catch { /* gone */ }
      }
    });
    rpc.onExit(() => {
      if (this.utilityProcess?.rpc === rpc) this.utilityProcess = undefined;
    });
    this.utilityProcess = { rpc, cwd };
    this.touchUtility();
    return rpc;
  }

  private touchUtility(): void {
    const current = this.utilityProcess;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      if (this.utilityProcess === current && this.loginUi.size === 0) {
        current.rpc.dispose();
        this.utilityProcess = undefined;
      }
    }, 5 * 60_000);
    current.timer.unref?.();
  }

  private async utilityReady(): Promise<OmpRpcProcess> {
    const rpc = this.utility(this.utilityProcess?.cwd ?? homedir());
    await Promise.race([
      rpc.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("omp did not become ready within 60s")), 60_000)),
    ]);
    return rpc;
  }

  async loginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
    const rpc = await this.utilityReady();
    const result = await rpc.request<{ providers?: any[] }>({ type: "get_login_providers" });
    return Array.isArray(result?.providers) ? result.providers : [];
  }

  /** OAuth login; omp opens the flow through `native.login.ui` events. Resolves when it finishes. */
  async login(providerId: string): Promise<{ providerId: string }> {
    const rpc = await this.utilityReady();
    try {
      return await rpc.request<{ providerId: string }>({ type: "login", providerId }, 11 * 60_000);
    } finally {
      this.loginUi.clear();
      this.recycleIdle();
    }
  }

  /** Answer omp's login prompt (pasted code / redirect URL); null cancels it. */
  loginRespond(requestId: string, value: string | null): boolean {
    const rpc = this.utilityProcess?.rpc;
    if (!rpc || !this.loginUi.delete(requestId)) return false;
    rpc.send(value === null ? { type: "extension_ui_response", id: requestId, cancelled: true } : { type: "extension_ui_response", id: requestId, value });
    return true;
  }

  /** Stop a login in progress (kills the helper process; nothing is saved). */
  cancelLogin(): void {
    this.loginUi.clear();
    this.utilityProcess?.rpc.dispose();
    this.utilityProcess = undefined;
  }

  async logoutAccounts(providerId: string): Promise<Array<Record<string, unknown>>> {
    const rpc = await this.utilityReady();
    const result = await rpc.request<{ accounts?: any[] }>({ type: "get_logout_accounts", providerId });
    return Array.isArray(result?.accounts) ? result.accounts : [];
  }

  async logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }> {
    const rpc = await this.utilityReady();
    const result = await rpc.request<{ remainingSource?: string }>({ type: "logout", providerId, credentialId });
    this.recycleIdle();
    return result ?? {};
  }

  /** Chats in desktop plan mode (kept by id: session records get rebuilt on refresh). */
  private readonly planModes = new Set<string>();

  planMode(id: string): boolean {
    return this.planModes.has(id);
  }

  /** Toggle desktop plan mode; the chat's omp process restarts on the next prompt. */
  setPlanMode(id: string, enabled: boolean): boolean {
    this.record(id);
    const runtime = this.runtimes.get(id);
    if (runtime?.isRunning) {
      throw Object.assign(new Error("Wait for the current reply to finish"), { errorCode: "AGENT_BUSY" });
    }
    if (enabled) this.planModes.add(id);
    else this.planModes.delete(id);
    // The flags are fixed per omp process: restart it on the next prompt.
    if (runtime && runtime.planMode !== enabled) this.dispose(id);
    return enabled;
  }

  /** Drop idle processes so the next prompt picks up changed omp settings. */
  recycleIdle(): void {
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.isRunning) this.dispose(id);
    }
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
/** Drop terminal colour / cursor escapes from omp's command output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function ompTreeNodes(node: any, parentId: string | null, onPath: Set<string>): OmpTreeNode[] {
  const entry = node?.entry ?? {};
  const id = String(entry.id ?? "");
  const message = entry.type === "message" ? entry.message : undefined;
  const role: OmpTreeNode["role"] | undefined = message
    ? message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : message.role === "toolResult" ? "tool" : "other"
    : entry.type === "compaction" || entry.type === "branch_summary" ? "system" : undefined;
  if (!role || role === "tool" || role === "other") {
    // Bookkeeping entries (model changes, labels, tool results) fold into their children.
    return (node?.children ?? []).flatMap((child: any) => ompTreeNodes(child, parentId, onPath));
  }
  const text = message ? textOf(message.content).text : String(entry.summary ?? "");
  const tools = message && Array.isArray(message.content)
    ? message.content.filter((part: any) => part?.type === "toolCall").map((part: any) => String(part.name ?? ""))
    : [];
  const preview = (text.trim() || (tools.length ? `⚙ ${tools.join(", ")}` : "")).replace(/\s+/g, " ").slice(0, 160);
  return [{
    id,
    parentId,
    role,
    preview,
    ...(entry.timestamp ? { timestamp: String(entry.timestamp) } : {}),
    onPath: onPath.has(id),
    children: (node?.children ?? []).flatMap((child: any) => ompTreeNodes(child, id, onPath)),
  }];
}

export function ompSessionService(): OmpSessionService {
  shared ??= new OmpSessionService();
  return shared;
}
export { listOmpRoles, setOmpRole, type OmpRole } from "./roles.js";
