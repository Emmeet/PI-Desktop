import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { assertOmpBinaryCompatible, OmpCompatibilityError } from "./binary.js";

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
  private exited = false;
  private disposed = false;
  private disposeTimer?: NodeJS.Timeout;
  private readyTimer?: NodeJS.Timeout;
  readonly ready: Promise<void>;

  constructor(binary: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; mode?: "rpc" | "rpc-ui" }) {
    // Make sure a Bun-installed omp can find `bun` even under a minimal GUI PATH.
    const env = { ...(options.env ?? process.env) };
    const sep = process.platform === "win32" ? ";" : ":";
    env.PATH = [dirname(binary), env.PATH ?? ""].filter(Boolean).join(sep);
    assertOmpBinaryCompatible(binary, env);
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
    this.readyTimer = setTimeout(() => {
      failReady(Object.assign(new Error("omp did not become ready within 60s. Check the omp installation and restart the app."), { errorCode: "OMP_START_FAILED" }));
      this.dispose();
    }, 60_000);
    this.readyTimer.unref?.();
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
        if (frame.type === "ready") {
          clearTimeout(this.readyTimer);
          if (frame.protocolVersion !== 1) {
            failReady(new OmpCompatibilityError("OMP_PROTOCOL_UNSUPPORTED", "omp did not start with the supported RPC protocol v1."));
            this.dispose();
            return;
          }
          markReady();
        }
        if (frame.type === "response" && typeof frame.id === "string" && this.pending.has(frame.id)) {
          const pending = this.pending.get(frame.id)!;
          this.pending.delete(frame.id);
          if (frame.success === false) pending.reject(new Error(String(frame.error ?? `omp ${frame.command} failed`)));
          else pending.resolve(frame.data);
        }
        for (const listener of this.listeners) listener(frame);
      }
    });
    // Drain without retaining stderr: extensions may print credentials.
    this.child.stderr.resume();
    const onExit = (reason: string) => {
      if (this.exited) return;
      this.exited = true;
      clearTimeout(this.readyTimer);
      clearTimeout(this.disposeTimer);
      const error = Object.assign(new Error(`omp exited (${reason})`), { errorCode: "OMP_PROCESS_EXITED" });
      failReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const listener of this.exitListeners) listener(error.message);
    };
    this.child.on("error", (error) => onExit(error.message));
    this.child.on("close", (code, signal) => onExit(signal ? `signal ${signal}` : `code ${code}`));
    this.child.stdin.on("error", () => onExit("stdin closed"));
  }

  get isAlive(): boolean {
    return !this.exited && !this.disposed;
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
    if (this.exited || this.disposed) throw Object.assign(new Error("omp process is not running"), { errorCode: "OMP_PROCESS_EXITED" });
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
    if (this.exited || this.disposed) return;
    this.disposed = true;
    clearTimeout(this.readyTimer);
    try { this.child.stdin.end(); } catch { /* already closed */ }
    if (process.platform === "win32" && this.child.pid) {
      // Killing cmd.exe alone leaves the actual Bun/Node agent running.
      const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => this.child.kill("SIGTERM"));
    } else {
      this.child.kill("SIGTERM");
    }
    this.disposeTimer = setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, 3000);
    this.disposeTimer.unref?.();
  }
}
