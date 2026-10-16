import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpSessionService } from "./service.js";

// Real external JSONL peer, with crash/drain driven by explicit protocol commands.
// Only Desktop's clock is faked: child readiness and stdout are real I/O signals.
const ENGINE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { console.log("omp/18.10.1"); process.exit(0); }
if (process.argv[2] === "config") { console.log(JSON.stringify({ value: {} })); process.exit(0); }
const root = process.env.RECOVERY_ROOT;
const value = (flag) => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
const file = value("--resume") || path.join(root, "agent", "sessions", "stable.jsonl");
const log = (entry) => fs.appendFileSync(path.join(root, "log.jsonl"), JSON.stringify({ pid: process.pid, ...entry }) + "\n");
log({ type: "spawn", argv: process.argv.slice(2), file });
const failPath = path.join(root, "failures.json");
if (fs.existsSync(failPath)) {
  const failures = JSON.parse(fs.readFileSync(failPath, "utf8"));
  if (failures > 0) { fs.writeFileSync(failPath, String(failures - 1)); process.exit(31); }
}
const out = (frame) => console.log(JSON.stringify(frame));
const reply = (cmd, data) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
let journal = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [{ type: "session", version: 3, id: "stable-engine-session", timestamp: new Date().toISOString(), cwd: root }];
let active;
let steering = [];
let followUp = [];
const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, journal.map(JSON.stringify).join("\n") + "\n"); };
const queues = () => out({ type: "queue_update", steering: steering.map((entry) => entry.message), followUp: followUp.map((entry) => entry.message) });
const deliver = (cmd) => {
  active = cmd;
  log({ type: "delivered", message: cmd.message });
  const message = { role: "user", content: cmd.message, attribution: "user" };
  const id = "user-" + journal.length;
  journal.push({ type: "message", id, parentId: journal.at(-1)?.id || null, timestamp: new Date().toISOString(), message }); save();
  out({ type: "agent_start" }); out({ type: "message_end", message, messageId: id });
};
const finish = () => {
  if (active) {
    const cmd = active; active = undefined;
    const message = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
    journal.push({ type: "message", id: "assistant-" + journal.length, parentId: journal.at(-1)?.id || null, timestamp: new Date().toISOString(), message }); save();
    out({ type: "message_end", message }); out({ type: "agent_end" });
    if (cmd.type === "prompt") out({ type: "prompt_result", id: cmd.id, status: "completed", sessionSettled: true });
    else out({ type: "session_settled" });
  }
};
save();
out({ type: "ready", protocolVersion: 1 });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const cmd = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    log({ type: "command", command: cmd.type, message: cmd.message });
    if (cmd.type === "get_state") reply(cmd, { sessionFile: file, sessionId: "stable-engine-session", isSettled: !active, isStreaming: !!active });
    else if (cmd.type === "get_available_models") reply(cmd, { models: [] });
    else if (cmd.type === "prompt") { reply(cmd); deliver(cmd); }
    else if (cmd.type === "steer" || cmd.type === "follow_up") {
      if (cmd.message === "uncertain") { log({ type: "possibly-delivered", message: cmd.message }); process.exit(32); }
      (cmd.type === "steer" ? steering : followUp).push(cmd); queues(); reply(cmd);
    }
    else if (cmd.type === "btw" && cmd.question === "fixture_crash") { reply(cmd); setImmediate(() => process.exit(33)); }
    else if (cmd.type === "btw" && cmd.question === "fixture_finish") { finish(); reply(cmd); }
    else if (cmd.type === "btw" && cmd.question === "fixture_drain") {
      finish();
      while (steering.length || followUp.length) { const next = steering.shift() || followUp.shift(); queues(); deliver(next); finish(); }
      reply(cmd);
    }
    else if (cmd.type === "abort") { finish(); reply(cmd); }
    else reply(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

type Recovery = { state: "retrying" | "connected" | "failed"; attempt: number; delayMs?: number };
type Log = { type: string; pid: number; argv?: string[]; message?: string; command?: string; file?: string };
type Harness = {
  root: string;
  service: OmpSessionService;
  id: string;
  notify: (event: AgentEventEnvelope) => void;
  events: AgentEventEnvelope[];
  recoveries: Recovery[];
  until: (predicate: () => boolean) => Promise<void>;
  logs: () => Log[];
};
const roots: string[] = [];
const services: OmpSessionService[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const service of services.splice(0)) service.disposeAll();
  vi.useRealTimers();
  process.env = { ...savedEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(delays = [250, 1000, 4000]): Harness {
  const root = mkdtempSync(join(tmpdir(), "omp recovery ")); roots.push(root);
  const script = join(root, "engine.cjs"); writeFileSync(script, ENGINE);
  const binary = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  writeFileSync(binary, process.platform === "win32" ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  process.env.PI_DESKTOP_OMP_BIN = binary;
  process.env.PI_DESKTOP_OMP_PREFS = join(root, "prefs.json");
  process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR = join(root, "outputs");
  process.env.RECOVERY_ROOT = root;
  process.env.PI_DESKTOP_OMP_HOST_TOOLS = "0";
  const service = new OmpSessionService({ agentDir: join(root, "agent"), reconnectDelays: delays }); services.push(service);
  const events: AgentEventEnvelope[] = [];
  const recoveries: Recovery[] = [];
  const subscribers = new Set<() => void>();
  service.setSideChannel((method, params) => {
    if (method === "native.recovery" && params && typeof params === "object" && "state" in params && "attempt" in params && typeof params.attempt === "number") {
      const state = params.state;
      if (state === "retrying" || state === "connected" || state === "failed") recoveries.push({ state, attempt: params.attempt });
    }
    for (const notify of subscribers) notify();
  });
  const notify = (event: AgentEventEnvelope) => { events.push(event); for (const subscriber of subscribers) subscriber(); };
  const until = (predicate: () => boolean): Promise<void> => {
    if (predicate()) return Promise.resolve();
    // The runtime targets ES2022, before Promise.withResolvers is available.
    return new Promise<void>((resolve) => {
      const observe = () => { if (predicate()) { subscribers.delete(observe); resolve(); } };
      subscribers.add(observe);
    });
  };
  const id = service.create({ projectPath: root }).id;
  const logs = (): Log[] => existsSync(join(root, "log.jsonl")) ? readFileSync(join(root, "log.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line) as Log) : [];
  return { root, service, id, notify, events, recoveries, until, logs };
}

async function initial(harness: Harness, text = "active") {
  await harness.service.prompt(harness.id, text, harness.notify);
  await harness.until(() => harness.events.some((event) => event.event.type === "message_end" && event.event.message.role === "user" && event.event.message.content === text));
}

async function crash(harness: Harness) {
  const previous = harness.recoveries.length;
  await harness.service.sessionCommand(harness.id, { type: "btw", question: "fixture_crash" }, harness.notify);
  await harness.until(() => harness.recoveries.length > previous && harness.recoveries.at(-1)?.state === "retrying");
}

describe("OMP automatic external process recovery", () => {
  it("resumes the same session, preserves inserted messages once/in order, and does not replay the interrupted prompt", async () => {
    const h = setup(); await initial(h);
    await h.service.steer(h.id, "one"); await h.service.followUp(h.id, "two");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await crash(h);
    await h.service.steer(h.id, "three"); await h.service.followUp(h.id, "four");
    await vi.advanceTimersByTimeAsync(249);
    expect(h.logs().filter((entry) => entry.type === "spawn")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await h.until(() => h.recoveries.at(-1)?.state === "connected");
    await h.service.sessionCommand(h.id, { type: "btw", question: "fixture_drain" }, h.notify);
    await h.until(() => !h.service.status(h.id).status.isRunning);
    const spawns = h.logs().filter((entry) => entry.type === "spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.argv).toEqual(expect.arrayContaining(["--resume", spawns[0]?.file, "--approval-mode", "write"]));
    expect(h.logs().filter((entry) => entry.type === "delivered").map((entry) => entry.message)).toEqual(["active", "one", "two", "three", "four"]);
    expect(h.events.filter((entry) => entry.event.type === "error").map((entry) => entry.event.type === "error" && entry.event.error.code)).toContain("OMP_DELIVERY_UNCERTAIN");
    expect(h.service.queueList(h.id)).toEqual([]);
  });

  it("bounds failed startups, retains the queue and allows an explicit new prompt to recover without reopening", async () => {
    const h = setup(); await initial(h); await h.service.followUp(h.id, "kept");
    writeFileSync(join(h.root, "failures.json"), "3");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); await crash(h);
    for (const [index, delay] of [250, 1000, 4000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      await h.until(() => h.recoveries.some((entry) => index === 2 ? entry.state === "failed" : entry.state === "retrying" && entry.attempt === index + 2));
    }
    expect(h.logs().filter((entry) => entry.type === "spawn")).toHaveLength(4);
    expect(h.service.queueList(h.id).map((entry) => entry.content)).toEqual(["kept"]);
    expect(h.events.some((entry) => entry.event.type === "error" && entry.event.error.code === "OMP_RECOVERY_FAILED")).toBe(true);
    const retry = h.service.prompt(h.id, "new", h.notify);
    const rejectedRetry = expect(retry).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
    await vi.advanceTimersByTimeAsync(250);
    await h.until(() => h.recoveries.at(-1)?.state === "connected"); await rejectedRetry;
    await h.service.sessionCommand(h.id, { type: "btw", question: "fixture_drain" }, h.notify);
    expect(h.logs().filter((entry) => entry.type === "delivered").map((entry) => entry.message)).toEqual(["active", "kept"]);
  });

  it("retains an ambiguous insertion for review and never resends it", async () => {
    const h = setup(); await initial(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(h.service.followUp(h.id, "uncertain")).rejects.toMatchObject({ errorCode: "OMP_DELIVERY_UNCERTAIN" });
    await h.until(() => h.recoveries.at(-1)?.state === "retrying");
    expect(h.service.queueList(h.id)).toEqual([expect.objectContaining({ content: "uncertain", deliveryStatus: "uncertain" })]);
    await vi.advanceTimersByTimeAsync(250);
    await h.until(() => h.recoveries.at(-1)?.state === "connected");
    expect(h.logs().filter((entry) => entry.message === "uncertain" && entry.type === "command")).toHaveLength(1);
    const entry = h.service.queueList(h.id)[0]!; await h.service.queueRemove(entry.id);
    expect(h.service.queueList(h.id)).toEqual([]);
  });

  it("cancels recovery timers and does not spawn after cancellation or disposal", async () => {
    const h = setup(); await initial(h); await h.service.followUp(h.id, "kept");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); await crash(h);
    expect(await h.service.abort(h.id, "stale-turn")).toEqual({ ok: false });
    expect(await h.service.abort(h.id)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.logs().filter((entry) => entry.type === "spawn")).toHaveLength(1);
    expect(h.service.queueList(h.id).map((entry) => entry.content)).toEqual(["kept"]);
    h.service.dispose(h.id); h.service.disposeAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.logs().filter((entry) => entry.type === "spawn")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh retry budget after separate completed crash/recover cycles", async () => {
    const h = setup(); await initial(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let index = 0; index < 4; index += 1) {
      await crash(h);
      await vi.advanceTimersByTimeAsync(250);
      await h.until(() => h.recoveries.at(-1)?.state === "connected");
      const spawn = h.logs().filter((entry) => entry.type === "spawn").at(-1)!;
      expect(spawn.argv).toEqual(expect.arrayContaining(["--approval-mode", "write"]));
      expect(h.recoveries.at(-1)?.attempt).toBe(1);
      await h.service.prompt(h.id, "cycle-" + index, h.notify);
      await h.service.sessionCommand(h.id, { type: "btw", question: "fixture_finish" }, h.notify);
      await h.until(() => !h.service.status(h.id).status.isRunning);
      if (index < 3) await initial(h, "next-" + index);
    }
  });

  it.each(["always-ask", "write", "yolo"])("applies the latest local %s override on reconnect", async (mode) => {
    const h = setup(); await initial(h);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await crash(h);
    h.service.setApprovalMode(mode);
    await vi.advanceTimersByTimeAsync(250);
    await h.until(() => h.recoveries.at(-1)?.state === "connected");
    expect(h.logs().filter((entry) => entry.type === "spawn").at(-1)?.argv).toEqual(expect.arrayContaining(["--approval-mode", mode]));
  });
});
