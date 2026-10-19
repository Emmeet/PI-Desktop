import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type * as Binary from "./binary.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmpRpcProcess } from "./rpc-process.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./binary.js", async (original) => ({
  ...await original<typeof Binary>(),
  assertOmpBinaryCompatible: vi.fn(),
}));

class Child extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

let child: Child;
let rpc: OmpRpcProcess;
beforeEach(() => {
  vi.useFakeTimers();
  child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  rpc = new OmpRpcProcess("omp", [], { cwd: "." });
});
afterEach(() => {
  rpc.dispose();
  child.emit("close", 0, null);
  vi.useRealTimers();
  vi.clearAllMocks();
});
const frame = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);

describe("OMP RPC framing and pending ownership", () => {
  it("ignores invalid JSON values and still accepts the next valid frame", async () => {
    const frames: unknown[] = [];
    rpc.onFrame((value) => frames.push(value));
    expect(() => child.stdout.write('null\n[]\n42\n"noise"\n{}\n{"type":7}\nnot-json\n')).not.toThrow();
    frame({ type: "ready", protocolVersion: 1 });
    await rpc.ready;
    expect(frames).toEqual([{ type: "ready", protocolVersion: 1 }]);
  });

  it("reads chunked Unicode payloads and a final unterminated response", async () => {
    frame({ type: "ready", protocolVersion: 1 });
    await rpc.ready;
    const payload = "世界\u2028\u2029".repeat(8192);
    let result: unknown;
    void rpc.request({ type: "get_state", id: "tail" }).then((value) => { result = value; }, () => undefined);
    const wire = Buffer.from(JSON.stringify({ type: "response", id: "tail", success: true, data: payload }));
    for (let start = 0; start < wire.length; start += 127) child.stdout.write(wire.subarray(start, start + 127));
    const ended = new Promise<void>((resolve) => child.stdout.once("end", resolve));
    child.stdout.end();
    await ended;
    await Promise.resolve();
    expect(result).toBe(payload);
  });

  it("rejects duplicate in-flight IDs without stealing the original response", async () => {
    let duplicateError: unknown;
    const original = rpc.request({ type: "get_state", id: "same" });
    void original.catch(() => undefined);
    void rpc.request({ type: "get_state", id: "same" }).catch((error: unknown) => { duplicateError = error; });
    await Promise.resolve();
    expect(duplicateError).toBeInstanceOf(Error);
    frame({ type: "response", id: "same", success: true, data: { original: true } });
    await expect(original).resolves.toEqual({ original: true });
    const reused = rpc.request({ type: "get_state", id: "same" });
    frame({ type: "response", id: "same", success: true, data: { reused: true } });
    await expect(reused).resolves.toEqual({ reused: true });
  });

  it("settles startup and requests immediately on disposal even before the child closes", async () => {
    let readyError: unknown;
    let requestError: unknown;
    void rpc.ready.catch((error: unknown) => { readyError = error; });
    void rpc.request({ type: "get_state" }).catch((error: unknown) => { requestError = error; });
    rpc.dispose();
    await Promise.resolve();
    expect(readyError).toMatchObject({ errorCode: "OMP_PROCESS_EXITED" });
    expect(requestError).toMatchObject({ errorCode: "OMP_PROCESS_EXITED" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("detaches framing on disposal and ignores buffered late frames", () => {
    const received = vi.fn();
    rpc.onFrame(received);
    child.stdout.write('{"type":"ready",');
    rpc.dispose();
    child.stdout.write('"protocolVersion":1}\n');
    frame({ type: "agent_start" });
    expect(received).not.toHaveBeenCalled();
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("kills a child whose stdin fails instead of abandoning the live process", async () => {
    let error: unknown;
    void rpc.request({ type: "get_state" }).catch((reason: unknown) => { error = reason; });
    child.stdin.emit("error", new Error("broken pipe"));
    await Promise.resolve();
    expect(error).toMatchObject({ errorCode: "OMP_PROCESS_EXITED" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
