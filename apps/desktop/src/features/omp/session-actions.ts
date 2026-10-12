export type SessionCommand = <T>(sessionId: string, command: Record<string, unknown> & { type: string }) => Promise<T>;
export type ActionEvent = { method: string; params: { sessionId?: string; frame?: Record<string, unknown> } };
export type BtwTurn = { question: string; answer: string; status: string; error?: string };
export type BtwRecord = BtwTurn & { id: string; followUps?: BtwTurn[] };
export type BtwState = { records: BtwRecord[]; selectedId?: string; pending?: BtwTurn; loading: boolean; busy: boolean; error: unknown | null };


/** A dialog owns only the side question it starts; closing invalidates all pending replies. */
export class BtwActions {
  private state: BtwState = { records: [], loading: true, busy: false, error: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  private generation = 0;
  private cancelling = false;
  private streamId: string | undefined;
  private streamStarted = false;
  private question: string | undefined;
  private revision = 0;
  private readonly sessionId: string;
  private readonly command: SessionCommand;
  constructor(sessionId: string, command: SessionCommand) {
    this.sessionId = sessionId;
    this.command = command;
  }
  getSnapshot = (): BtwState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<BtwState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  async load(): Promise<void> {
    if (this.disposed || this.state.busy) return;
    this.update({ loading: true, error: null });
    const revision = this.revision;
    try {
      const { records } = await this.command<{ records: BtwRecord[] }>(this.sessionId, { type: "get_btw_history" });
      if (revision === this.revision) this.update({ records, selectedId: records.at(-1)?.id });
    } catch (error) {
      this.update({ error });
    } finally {
      this.update({ loading: false });
    }
  }
  select(recordId?: string): void {
    if (!this.state.busy) this.update({ selectedId: recordId, error: null });
  }
  private save(record: BtwRecord): void {
    this.revision++;
    const records = [...this.state.records];
    const index = records.findIndex((entry) => entry.id === record.id);
    if (index < 0) records.push(record);
    else records[index] = record;
    this.update({ records, selectedId: record.id, pending: undefined });
  }
  event = (event: ActionEvent): void => {
    if (this.disposed || event.method !== "native.btw" || event.params.sessionId !== this.sessionId || !this.state.busy) return;
    const frame = event.params.frame;
    if (frame?.type === "btw_record") {
      const record = frame.record as BtwRecord;
      if (!record?.id || (this.streamId && record.id !== this.streamId) || (record.followUps?.at(-1) ?? record).question !== this.question) return;
      this.streamId = record.id;
      this.streamStarted = true;
      this.save(record);
    } else if (frame?.type === "btw_delta" && this.streamStarted && frame.recordId === this.streamId && typeof frame.delta === "string") {
      const record = this.state.records.find((entry) => entry.id === this.streamId);
      if (!record || (record.followUps?.at(-1) ?? record).status !== "running") return;
      const delta = frame.delta;
      const followUps = record.followUps?.map((turn, index, turns) => index === turns.length - 1 ? { ...turn, answer: turn.answer + delta } : turn);
      this.save(followUps?.length ? { ...record, followUps } : { ...record, answer: record.answer + delta });
    }
  };
  async ask(question: string): Promise<boolean> {
    const text = question.trim();
    if (this.disposed || this.state.busy || this.cancelling || this.state.loading || !text) return false;
    const generation = ++this.generation;
    this.streamId = this.state.selectedId;
    this.streamStarted = false;
    this.question = text;
    this.update({ busy: true, error: null, pending: { question: text, answer: "", status: "running" } });
    try {
      const { record } = await this.command<{ record: BtwRecord }>(this.sessionId, { type: "btw", question: text, ...(this.streamId ? { recordId: this.streamId } : {}) });
      if (this.disposed || generation !== this.generation) return false;
      this.save(record);
      return true;
    } catch (error) {
      if (generation === this.generation) this.update({ error });
      return false;
    } finally {
      if (generation === this.generation) {
        this.update({ busy: this.cancelling, pending: undefined });
        this.streamId = undefined;
        this.streamStarted = false;
        this.question = undefined;
      }
    }
  }
  async cancel(): Promise<void> {
    if (!this.state.busy || this.cancelling) return;
    this.cancelling = true;
    const streamId = this.streamId;
    const generation = this.generation;
    try {
      const reply = await this.command<{ cancelled: boolean }>(this.sessionId, { type: "btw_cancel", ...(streamId ? { recordId: streamId } : {}) });
      if (this.disposed || generation !== this.generation) return;
      if (!reply.cancelled) {
        const { records } = await this.command<{ records: BtwRecord[] }>(this.sessionId, { type: "get_btw_history" });
        if (this.disposed || generation !== this.generation) return;
        this.update({ records, selectedId: streamId ?? records.at(-1)?.id });
      } else {
        const record = this.state.records.find((entry) => entry.id === (this.streamId ?? streamId));
        if (record && (record.followUps?.at(-1) ?? record).status === "running") {
          const followUps = record.followUps?.map((turn, index, turns) => index === turns.length - 1 ? { ...turn, status: "cancelled" } : turn);
          this.save(followUps?.length ? { ...record, followUps } : { ...record, status: "cancelled" });
        }
      }
      ++this.generation;
      this.streamId = undefined;
      this.streamStarted = false;
      this.question = undefined;
      this.update({ busy: false, pending: undefined, error: null });
    } catch (error) {
      if (generation === this.generation) this.update({ error, busy: this.question !== undefined });
    } finally {
      this.cancelling = false;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    void this.cancel();
    this.disposed = true;
    ++this.generation;
    this.listeners.clear();
  }
}

export type Goal = { objective: string; status: "active" | "paused" | "budget-limited" | "complete" | "dropped"; tokensUsed: number; tokenBudget?: number };
export type GoalResult = { goal: Goal | null; state: unknown };
export type GoalOp = "get" | "create" | "resume" | "pause" | "drop";
export type GoalState = { goal: Goal | null | undefined; busy: boolean; error: unknown | null };

export class GoalActions {
  private state: GoalState = { goal: undefined, busy: false, error: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  private revision = 0;
  private readonly sessionId: string;
  private readonly command: SessionCommand;
  constructor(sessionId: string, command: SessionCommand) {
    this.sessionId = sessionId;
    this.command = command;
  }
  getSnapshot = (): GoalState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<GoalState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  event = (event: ActionEvent): void => {
    if (event.method !== "native.goal" || event.params.sessionId !== this.sessionId || event.params.frame?.type !== "goal_updated") return;
    this.revision++;
    this.update({ goal: event.params.frame.goal as Goal | null });
  };
  async run(op: GoalOp, extra: { objective?: string; token_budget?: number } = {}): Promise<void> {
    if (this.disposed || this.state.busy) return;
    const revision = this.revision;
    this.update({ busy: true, error: null });
    try {
      const result = await this.command<GoalResult>(this.sessionId, { type: "goal", op, ...extra });
      if (revision === this.revision) this.update({ goal: result.goal });
    } catch (error) {
      this.update({ error });
    } finally {
      this.update({ busy: false });
    }
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export type OmpLoop = { prompt: string; total: number; done: number };

/** Handoff compacts the same session; cancellation must never look like success. */
export async function runHandoff(input: {
  sessionId: string;
  instructions: string;
  command: SessionCommand;
  failureMessage: string;
  isCurrent: () => boolean;
  refreshSessions: () => Promise<unknown>;
  selectSession: (sessionId: string) => Promise<unknown>;
}): Promise<"completed" | "cancelled" | "stale"> {
  const result = await input.command<{ savedPath?: string } | null>(input.sessionId, {
    type: "handoff",
    ...(input.instructions.trim() ? { customInstructions: input.instructions.trim() } : {}),
  });
  if (!input.isCurrent()) return "stale";
  if (result === null) return "cancelled";
  if (!result || typeof result !== "object") throw new Error(input.failureMessage);
  await input.refreshSessions();
  if (!input.isCurrent()) return "stale";
  await input.selectSession(input.sessionId);
  return input.isCurrent() ? "completed" : "stale";
}
