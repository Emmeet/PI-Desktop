import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";

export type OmpFrame = Record<string, any> & { type: string };

/** Quote one argument for cmd.exe when an omp .cmd shim has to run through a shell. */
function winQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

type Pending = { resolve: (data: any) => void; reject: (error: Error) => void };

/**
 * One `omp --mode rpc` child process speaking omp's JSONL protocol over stdio
 * (see oh-my-pi docs/rpc.md). Stays on protocol v1: oversized frames are
 * elided by omp rather than chunked, which is acceptable for a UI projection.
 */
export class OmpRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(frame: OmpFrame) => void>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  private stderrTail = "";
  private exited = false;
  readonly ready: Promise<void>;

  constructor(binary: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; mode?: "rpc" | "rpc-ui" }) {
    // Make sure a Bun-installed omp can find `bun` even under a minimal GUI PATH.
    const env = { ...(options.env ?? process.env) };
    const sep = process.platform === "win32" ? ";" : ":";
    env.PATH = [dirname(binary), env.PATH ?? ""].filter(Boolean).join(sep);
    // `rpc-ui` gives omp an interactive UI over the same JSONL channel, which
    // is what tool approvals and the ask tool need (extension_ui_request).
    const command = [binary, ["--mode", options.mode ?? "rpc", ...args]] as const;
    // npm/bun shims on Windows are .cmd files, which spawn cannot exec directly.
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
    this.child = spawn(shim ? `"${binary}"` : command[0], shim ? command[1].map(winQuote) : [...command[1]], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(shim ? { shell: true } : {}),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    this.ready.catch(() => undefined);
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let frame: OmpFrame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.type === "ready") markReady();
        if (frame.type === "response" && typeof frame.id === "string" && this.pending.has(frame.id)) {
          const pending = this.pending.get(frame.id)!;
          this.pending.delete(frame.id);
          if (frame.success === false) pending.reject(new Error(String(frame.error ?? `omp ${frame.command} failed`)));
          else pending.resolve(frame.data);
        }
        for (const listener of this.listeners) listener(frame);
      }
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    const onExit = (reason: string) => {
      if (this.exited) return;
      this.exited = true;
      const error = new Error(`omp exited (${reason})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-800)}` : ""}`);
      failReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const listener of this.exitListeners) listener(error.message);
    };
    this.child.on("error", (error) => onExit(error.message));
    this.child.on("exit", (code, signal) => onExit(signal ? `signal ${signal}` : `code ${code}`));
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  onFrame(listener: (frame: OmpFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  nextId(prefix = "req"): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  send(command: Record<string, unknown>): void {
    if (this.exited) throw new Error("omp process is not running");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  request<T = any>(command: Record<string, unknown> & { type: string }, timeoutMs = 30_000): Promise<T> {
    const id = typeof command.id === "string" ? command.id : this.nextId(command.type);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp ${command.type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.send({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  dispose(): void {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { if (!this.exited) this.child.kill("SIGTERM"); }, 3000);
    timer.unref?.();
  }
}
