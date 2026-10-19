import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { OmpSessionService, type OmpSideChannel } from "./service.js";

// Protocol fixture performs state transitions and journal writes. Assertions below
// exercise the production public service and actual spawned JSONL transport.
const ENGINE = String.raw`#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("18.10.0\n"); process.exit(0); }
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "config") { process.stdout.write(JSON.stringify({ value: {} })); process.exit(0); }
const value = (flag) => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
const cwd = value("--cwd") || process.cwd();
let file = value("--resume") || path.join(process.env.P2_SESSIONS, "project", process.pid + ".jsonl");
let journal = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
let sid = journal.find((entry) => entry.type === "session")?.id || "sid-" + process.pid;
let leaf = journal.at(-1)?.id || null;
let sequence = journal.length;
let slow = false;
let warming = "off";
let active;
let pending = false;
let goal = null;
const btw = new Map();
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const reply = (cmd, data) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
const save = () => {
  if (!journal.length) journal.push({ type: "session", id: sid, cwd, timestamp: new Date().toISOString(), version: 3 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, journal.map(JSON.stringify).join("\n") + "\n");
};
const append = (type, fields) => {
  const entry = { type, id: "entry-" + (++sequence), parentId: leaf, timestamp: new Date().toISOString(), ...fields };
  if (!journal.length) save();
  journal.push(entry); leaf = entry.id; save(); return entry;
};
const finish = (cmd, status = "completed", settled = true) => {
  active = undefined;
  out({ type: "agent_end", messages: [] });
  out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status, sessionSettled: settled, ...(status === "error" ? { error: { message: "provider failed", retryable: false } } : {}) });
};
const handle = (cmd) => {
  fs.appendFileSync(process.env.P2_LOG, JSON.stringify({ pid: process.pid, type: cmd.type, command: cmd, file }) + "\n");
  if (["set_ask_dialog", "set_subagent_subscription", "set_host_tools", "set_host_uri_schemes", "set_fast_mode"].includes(cmd.type)) {
    if (process.env.P2_REJECT_HOST === "1" && cmd.type === "set_host_tools") out({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "host registration rejected" });
    else reply(cmd, {});
  } else if (cmd.type === "get_state") reply(cmd, { sessionFile: file, sessionId: sid, isStreaming: !!active, isCompacting: false, hasPendingAsyncWork: pending, isSettled: !active && !pending });
  else if (cmd.type === "set_slow_mode") {
    if (typeof cmd.enabled !== "boolean") out({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "set_slow_mode requires boolean enabled" });
    else { slow = cmd.enabled; reply(cmd, { enabled: slow }); }
  }
  else if (cmd.type === "set_cache_warming") {
    if (!["off", "streaming", "idle"].includes(cmd.mode)) out({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "Invalid cache warming mode" });
    else { warming = cmd.mode; reply(cmd, { mode: warming }); }
  }
  else if (cmd.type === "predict_word") reply(cmd, { suffix: "tion" });
  else if (cmd.type === "predict_word_feedback") reply(cmd);
  else if (cmd.type === "get_subagent_messages") reply(cmd, {});
  else if (cmd.type === "goal") {
    goal = cmd.op === "drop" ? null : cmd.op === "create" ? { goal: { objective: cmd.objective, status: "active" }, enabled: true } : goal;
    if (goal && cmd.op === "pause") goal = { ...goal, enabled: false, goal: { ...goal.goal, status: "paused" } };
    if (goal && cmd.op === "resume") goal = { ...goal, enabled: true, goal: { ...goal.goal, status: "active" } };
    out({ type: "goal_updated", state: goal }); reply(cmd, { goal: goal?.goal || null, state: goal });
    if (cmd.op === "create") setImmediate(() => {
      out({ type: "agent_start" });
      const message = { role: "assistant", content: [{ type: "text", text: "Goal continuation" }], stopReason: "stop" };
      append("message", { message }); out({ type: "message_end", message, messageId: "goal-message" });
      out({ type: "agent_end", messages: [] }); out({ type: "session_settled" });
    });
  } else if (cmd.type === "handoff") {
    if (cmd.customInstructions === "cancel") { reply(cmd, null); return; }
    append("compaction", { summary: "Handoff summary", firstKeptEntryId: journal.find((entry) => entry.type === "message")?.id, tokensBefore: 12 });
    reply(cmd, { savedPath: path.join(cwd, "handoff.md") });
  } else if (cmd.type === "export_html") {
    const target = cmd.outputPath || path.join(cwd, "session.html");
    fs.writeFileSync(target, "<html><body><main>Engine export</main></body></html>"); reply(cmd, { path: target });
  } else if (cmd.type === "btw") {
    const record = { id: cmd.recordId || "btw-1", question: cmd.question, answer: "", status: "running", createdAt: Date.now() };
    const complete = () => {
      record.answer = "Side answer"; record.status = "complete";
      out({ type: "btw_delta", recordId: record.id, delta: record.answer }); out({ type: "btw_record", record });
      reply(cmd, { record }); btw.set(record.id, { record });
    };
    const handle = cmd.question === "hold" ? undefined : setImmediate(complete);
    btw.set(record.id, { record, handle, cmd }); out({ type: "btw_record", record });
  } else if (cmd.type === "btw_cancel") {
    const entry = btw.get(cmd.recordId);
    if (entry?.cmd) { clearImmediate(entry.handle); entry.record.status = "cancelled"; out({ type: "btw_record", record: entry.record }); reply(entry.cmd, { record: entry.record }); }
    reply(cmd, { cancelled: !!entry });
  } else if (cmd.type === "get_btw_history") reply(cmd, { records: [...btw.values()].map((entry) => entry.record) });
  else if (cmd.type === "host_tool_result") { out({ type: "notice", level: "info", message: "Host result received" }); }
  else if (cmd.type === "abort") { if (active) finish(active, "aborted"); reply(cmd); }
  else if (cmd.type === "prompt") {
    if (cmd.message === "reject") { out({ type: "response", id: cmd.id, command: cmd.type, success: false, error: "prompt setup rejected" }); return; }
    if (cmd.message.startsWith("/")) {
      if (cmd.message === "/saved") append("message", { message: { role: "user", content: cmd.message, attribution: "user" } });
      if (cmd.message === "/metadata") append("thinking_level_change", { thinkingLevel: "high" });
      out({ type: "command_output", text: cmd.message === "/login" ? "PRIVATE_TOKEN" : "Session <safe>" });
      if (cmd.message === "/multiple") out({ type: "command_output", text: "Second chunk" });
      reply(cmd, { agentInvoked: false }); return;
    }
    active = cmd; reply(cmd); out({ type: "agent_start" });
    const user = { role: "user", content: cmd.message, attribution: "user" };
    const entry = append("message", { message: user }); out({ type: "message_end", message: user, messageId: entry.id });
    if (cmd.message === "hold") return;
    if (cmd.message === "host") out({ type: "host_tool_call", id: "host-1", toolCallId: "root-tool", toolName: "desktop_clipboard_read", arguments: {} });
    if (cmd.message === "subagents") {
      out({ type: "subagent_lifecycle", payload: { id: "orphan", agent: "task", index: 0, status: "aborted" } });
      out({ type: "subagent_lifecycle", payload: { id: "root-stub", agent: "task", index: 0, status: "started" } });
      out({ type: "subagent_lifecycle", payload: { id: "root-stub", agent: "task", index: 0, status: "aborted" } });
      const subagentFile = path.join(cwd, "subagent.jsonl");
      fs.writeFileSync(subagentFile, [
        { type: "session", id: "subagent", timestamp: new Date().toISOString(), cwd },
        { type: "message", id: "subagent-message", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: "Owned subagent transcript" } },
      ].map(JSON.stringify).join("\n") + "\n");
      out({ type: "subagent_lifecycle", payload: { id: "real", agent: "scout", parentToolCallId: "root-tool", index: 0, status: "started", sessionFile: subagentFile } });
      out({ type: "subagent_progress", payload: { agent: "scout", parentToolCallId: "root-tool", index: 0, task: "Inspect", progress: { id: "real", toolCount: 2, tokens: 15, status: "running" } } });
      out({ type: "tool_execution_start", toolCallId: "root-tool", toolName: "task", args: {} });
      out({ type: "subagent_lifecycle", payload: { id: "nested", agent: "task", parentToolCallId: "nested-tool", index: 0, status: "started" } });
      out({ type: "subagent_lifecycle", payload: { id: "cancelled", agent: "task", parentToolCallId: "root-tool", index: 1, status: "started" } });
      out({ type: "subagent_lifecycle", payload: { id: "cancelled", agent: "task", parentToolCallId: "root-tool", index: 1, status: "aborted" } });
      out({ type: "subagent_lifecycle", payload: { id: "real", agent: "scout", parentToolCallId: "root-tool", index: 0, status: "completed" } });
      out({ type: "tool_execution_end", toolCallId: "root-tool", toolName: "task", result: { content: [] } });
    }
    const assistant = { role: "assistant", content: [{ type: "text", text: "Completed" }], stopReason: "stop" };
    const saved = append("message", { message: assistant }); out({ type: "message_end", message: assistant, messageId: saved.id });
    if (cmd.message === "unsettled") {
      pending = true; finish(cmd, "completed", false);
      setImmediate(() => { pending = false; out({ type: "session_settled" }); });
    } else finish(cmd, cmd.message === "fail" ? "error" : "completed");
  }
};
out({ type: "ready", protocolVersion: 1 });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf("\n")) >= 0) { const cmd = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); handle(cmd); }
});
process.stdin.on("end", () => process.exit(0));
`;

const savedEnv = { ...process.env };
const roots: string[] = [];
const services: OmpSessionService[] = [];
type ObservedSide = {
  method: string;
  params: {
    sessionId?: string;
    level?: string;
    message?: string;
    frame?: { type?: string; record?: { id?: string } };
    event?: { type: string };
    loop?: { done: number } | null;
  };
};

function observeSide(sides: ObservedSide[]): OmpSideChannel {
  return (method, params) => {
    // These values are emitted in-process by the production service, not untrusted fixture input.
    const data = params as ObservedSide["params"];
    sides.push({ method, params: data });
  };
}
afterEach(() => {
  for (const service of services.splice(0)) service.disposeAll();
  process.env = { ...savedEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(side?: OmpSideChannel) {
  const root = mkdtempSync(join(tmpdir(), "omp-p2-")); roots.push(root);
  const bin = join(root, "omp"); writeFileSync(bin, ENGINE); chmodSync(bin, 0o755);
  const agentDir = join(root, "agent"); const sessionRoot = join(agentDir, "sessions"); mkdirSync(sessionRoot, { recursive: true });
  process.env.PI_DESKTOP_OMP_BIN = bin;
  process.env.PI_DESKTOP_OMP_PREFS = join(root, "prefs.json");
  process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR = join(root, "outputs");
  process.env.P2_SESSIONS = sessionRoot;
  process.env.P2_LOG = join(root, "calls.jsonl");
  delete process.env.PI_DESKTOP_OMP_HOST_TOOLS;
  const service = new OmpSessionService({ agentDir, sessionRoot }); services.push(service);
  if (side) service.setSideChannel(side);
  const session = service.create({ projectPath: root });
  return { root, agentDir, sessionRoot, service, id: session.id };
}

async function runPrompt(service: OmpSessionService, id: string, content: string): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  const ended = new Promise<void>((resolve) => {
    void service.prompt(id, content, (event) => { events.push(event); if (event.event.type === "agent_end") resolve(); }, "optimistic-" + content);
  });
  await ended;
  return events;
}

function calls(root: string): Array<{ pid: number; type: string; file: string }> {
  return readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("pid" in value) || typeof value.pid !== "number" || !("type" in value) || typeof value.type !== "string" || !("file" in value) || typeof value.file !== "string") throw new Error("Invalid protocol fixture call");
    return { pid: value.pid, type: value.type, file: value.file };
  });
}

describe("OMP P2 public service user paths", () => {
  it("persists a local slash before turn end, including empty sessions and multiple output frames across restart", async () => {
    const { service, id, agentDir, sessionRoot } = setup();
    await runPrompt(service, id, "/multiple");
    const first = service.detail(id)!;
    expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(first.messages[0]?.content).toBe("/multiple");
    expect((await service.list())[0]?.messageCount).toBe(3);
    service.disposeAll();
    const reopened = new OmpSessionService({ agentDir, sessionRoot }); services.push(reopened);
    const restored = (await reopened.list())[0]!;
    expect(restored.id).toBe(id);
    expect(reopened.detail(id)?.messages).toEqual(first.messages);
    await runPrompt(reopened, id, "normal");
    await runPrompt(reopened, id, "/multiple");
    const last = reopened.detail(id)!;
    expect(last.messages.filter((message) => message.content === "/multiple")).toHaveLength(2);
    expect(last.messages.filter((message) => message.content.includes("Second chunk"))).toHaveLength(2);
    reopened.disposeAll();
    const materialized = new OmpSessionService({ agentDir, sessionRoot }); services.push(materialized);
    expect((await materialized.list())[0]?.id).toBe(id);
    expect(materialized.detail(id)?.messages).toEqual(last.messages);
  });

  it("does not duplicate a persisted slash user row and includes public output safely in HTML export", async () => {
    const { service, id, root } = setup();
    await runPrompt(service, id, "normal");
    await runPrompt(service, id, "/saved");
    await runPrompt(service, id, "/login");
    expect(service.detail(id)?.messages.filter((message) => message.content === "/saved")).toHaveLength(1);
    expect(service.detail(id)?.messages.some((message) => message.content.includes("PRIVATE_TOKEN"))).toBe(false);
    const result = await service.sessionCommand(id, { type: "export_html", outputPath: join(root, "export.html") });
    expect(result).toEqual({ path: join(root, "export.html") });
    const html = readFileSync(join(root, "export.html"), "utf8");
    expect(html).toContain("Session &lt;safe&gt;");
    expect(html).not.toContain("PRIVATE_TOKEN");
  });

  it("retains BTW/goal/mode state in one process, forwards side records, and handoff never resumes a document", async () => {
    const sides: ObservedSide[] = [];
    const { service, id, root } = setup(observeSide(sides));
    expect(await service.sessionCommand(id, { type: "set_slow_mode", enabled: true })).toEqual({ enabled: true });
    expect(await service.sessionCommand(id, { type: "set_cache_warming", mode: "idle" })).toEqual({ mode: "idle" });
    await expect(service.sessionCommand(id, { type: "set_cache_warming", mode: "always" })).rejects.toThrow("Invalid cache warming mode");
    const waiting = service.sessionCommand(id, { type: "btw", question: "hold", recordId: "held" });
    await vi.waitFor(() => expect(sides.some((event) => event.method === "native.btw" && event.params.frame?.record?.id === "held")).toBe(true));
    expect(await service.sessionCommand(id, { type: "btw_cancel", recordId: "held" })).toEqual({ cancelled: true });
    expect(await waiting).toMatchObject({ record: { id: "held", status: "cancelled" } });
    await service.sessionCommand(id, { type: "btw", question: "What?", recordId: "complete" });
    expect(sides.some((event) => event.method === "native.btw" && event.params.frame?.type === "btw_delta")).toBe(true);
    expect(await service.sessionCommand(id, { type: "get_btw_history" })).toMatchObject({ records: [{ id: "held" }, { id: "complete" }] });
    await service.sessionCommand(id, { type: "goal", op: "create", objective: "Inspect" });
    await vi.waitFor(() => expect(service.detail(id)?.messages.some((message) => message.content === "Goal continuation")).toBe(true));
    await vi.waitFor(() => expect(service.status(id).status.isRunning).toBe(false));
    expect(sides.some((event) => event.method === "native.goal" && event.params.frame?.type === "goal_updated")).toBe(true);
    expect(sides.some((event) => event.method === "native.agent.event" && event.params.event?.type === "message_end")).toBe(true);
    expect(await service.sessionCommand(id, { type: "goal", op: "get" })).toMatchObject({ goal: { objective: "Inspect", status: "active" }, state: { enabled: true } });
    expect(await service.sessionCommand(id, { type: "goal", op: "pause" })).toMatchObject({ goal: { status: "paused" }, state: { enabled: false } });
    expect(await service.sessionCommand(id, { type: "goal", op: "resume" })).toMatchObject({ goal: { status: "active" }, state: { enabled: true } });
    expect(await service.sessionCommand(id, { type: "goal", op: "drop" })).toEqual({ goal: null, state: null });
    expect(await service.sessionCommand(id, { type: "handoff" })).toEqual({ savedPath: join(root, "handoff.md") });
    expect(service.detail(id)?.compactions?.at(-1)?.summary).toBe("Handoff summary");
    const changes = sides.filter((event) => event.method === "native.session.changed").length;
    expect(await service.sessionCommand(id, { type: "handoff", customInstructions: "cancel" })).toBe(null);
    expect(sides.filter((event) => event.method === "native.session.changed")).toHaveLength(changes);
    await runPrompt(service, id, "after handoff");
    const requests = calls(root);
    expect(new Set(requests.map((call) => call.pid)).size).toBe(1);
    expect(requests.some((call) => call.file.endsWith("handoff.md"))).toBe(false);
  });

  it("projects root task owners, excluding orphan/root/nested stubs without hiding genuine zero-tool cancellations", async () => {
    const { service, id } = setup();
    await runPrompt(service, id, "subagents");
    expect(service.subagents(id).map((agent) => agent.id)).toEqual(["real", "cancelled"]);
    expect(service.subagents(id)[0]).toMatchObject({ status: "completed", toolCount: 2, tokens: 15 });
    expect(service.subagents(id)[1]).toMatchObject({ status: "aborted" });
  });

  it("authorizes subagent transcript paths against engine-owned identities", async () => {
    const { service, id, root } = setup();
    await runPrompt(service, id, "subagents");
    const known = service.subagents(id).find((agent) => agent.id === "real")!.sessionFile!;
    expect(await service.subagentMessages(id, "real", known)).toEqual([expect.objectContaining({ content: "Owned subagent transcript" })]);
    expect(await service.subagentMessages(id, "real")).toEqual([expect.objectContaining({ content: "Owned subagent transcript" })]);
    const unrelated = join(root, "unrelated.jsonl");
    writeFileSync(unrelated, readFileSync(known));
    const before = calls(root).filter((call) => call.type === "get_subagent_messages").length;
    await expect(service.subagentMessages(id, "real", unrelated)).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
    await expect(service.subagentMessages(id, "unknown", known)).rejects.toMatchObject({ errorCode: "PERMISSION_DENIED" });
    expect(calls(root).filter((call) => call.type === "get_subagent_messages")).toHaveLength(before);
  });

  it("waits for settlement and runs exactly the requested server-owned loop count without renderer involvement", async () => {
    const sides: ObservedSide[] = [];
    const { service, id, root } = setup(observeSide(sides));
    await service.sessionCommand(id, { type: "loop_start", prompt: "unsettled", count: 3 });
    await vi.waitFor(() => expect(sides.filter((event) => event.method === "native.loop" && event.params.loop?.done === 3)).toHaveLength(1));
    expect(await service.sessionCommand(id, { type: "get_loop" })).toEqual({ loop: null });
    expect(calls(root).filter((call) => call.type === "prompt")).toHaveLength(3);
    expect(service.detail(id)?.messages.filter((message) => message.role === "user")).toHaveLength(3);
    await expect(service.sessionCommand(id, { type: "loop_start", prompt: "x", count: 1.5 })).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  });

  it("stops loops on engine failure and manual abort, and settings recycling never interrupts an active paid turn", async () => {
    const sides: ObservedSide[] = [];
    const { service, id, root } = setup(observeSide(sides));
    await service.sessionCommand(id, { type: "loop_start", prompt: "fail", count: 5 });
    await vi.waitFor(() => expect(service.status(id).status.isRunning).toBe(false));
    expect(await service.sessionCommand(id, { type: "get_loop" })).toEqual({ loop: null });
    expect(calls(root).filter((call) => call.type === "prompt")).toHaveLength(1);
    expect(sides.some((event) => event.method === "native.agent.event" && event.params.event?.type === "error")).toBe(true);
    await service.sessionCommand(id, { type: "loop_start", prompt: "hold", count: 5 });
    await service.recycleIdle();
    expect(service.status(id).status.isRunning).toBe(true);
    expect(sides.some((event) => event.method === "native.host.closed")).toBe(false);
    await expect(service.sessionCommand(id, { type: "handoff" })).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
    await service.abort(id);
    await vi.waitFor(() => expect(sides.some((event) => event.method === "native.host.closed")).toBe(true));
    expect(calls(root).filter((call) => call.type === "prompt")).toHaveLength(2);
    expect(await service.sessionCommand(id, { type: "get_loop" })).toEqual({ loop: null });
  });

  it("routes host frames unchanged, returns host results on the live process, and closes each host session once", async () => {
    const sides: ObservedSide[] = [];
    const { service, id, root } = setup(observeSide(sides));
    await runPrompt(service, id, "host");
    expect(sides.find((event) => event.method === "native.host.request")).toMatchObject({ params: { sessionId: id, frame: { type: "host_tool_call", id: "host-1", arguments: {} } } });
    service.hostRespond(id, { type: "host_tool_result", id: "host-1", result: { content: [{ type: "text", text: "clipboard" }] } });
    await vi.waitFor(() => expect(calls(root).some((call) => call.type === "host_tool_result")).toBe(true));
    const types = calls(root).map((call) => call.type);
    expect(types.indexOf("set_host_tools")).toBeLessThan(types.indexOf("prompt"));
    service.dispose(id);
    expect(sides.filter((event) => event.method === "native.host.closed")).toHaveLength(1);
    expect(() => service.hostRespond(id, { type: "host_tool_result", id: "host-1", result: { content: [] } })).toThrow("no longer running");
  });

  it("settles a rejected prompt before accepting the next user turn", async () => {
    const { service, id } = setup();
    const failed = await runPrompt(service, id, "reject");
    expect(failed.some((event) => event.event.type === "error")).toBe(true);
    expect(service.status(id).status.isRunning).toBe(false);
    await runPrompt(service, id, "normal");
    expect(service.detail(id)?.messages.map((message) => message.content)).toEqual(["normal", "Completed"]);
  });

  it.each(["frame", "transport"] as const)("never swallows a %s prompt failure when the turn finalizes immediately", async (kind) => {
    const { service, id } = setup();
    await runPrompt(service, id, "normal");
    type Runtime = { refreshSessionFile: () => Promise<void>; rpc: { request: (command: { type: string }) => Promise<unknown> } };
    const runtime = (service as unknown as { runtimes: Map<string, Runtime> }).runtimes.get(id)!;
    // Fastest possible settlement: the turn is finalized in the same microtask
    // burst as the rejection, before the service's catch handler runs.
    runtime.refreshSessionFile = () => Promise.resolve();
    if (kind === "transport") {
      const request = runtime.rpc.request.bind(runtime.rpc);
      runtime.rpc.request = (command) => command.type === "prompt" ? Promise.reject(new Error("transport broke")) : request(command);
    }
    const events: AgentEventEnvelope[] = [];
    const { turnId } = await service.prompt(id, kind === "frame" ? "reject" : "anything", (event) => { events.push(event); }, "optimistic-fast");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const errors = events.filter((event) => event.event.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const error of errors) expect(error).toMatchObject({ sessionId: id, turnId });
    expect(errors.some((error) => JSON.stringify(error.event).includes(kind === "frame" ? "prompt setup rejected" : "transport broke"))).toBe(true);
    expect(service.status(id).status.isRunning).toBe(false);
  });

  it("keeps resolving an optimistic message id every time it is used (fork, edit, regenerate)", async () => {
    const { service, id } = setup();
    await runPrompt(service, id, "normal");
    type Internals = { records: Map<string, unknown>; resolveEntryId(record: unknown, messageId: string): string; aliases: Map<string, string>; setAlias(shown: string, engine: string): void };
    const internals = service as unknown as Internals;
    const record = internals.records.get(id);
    // The transcript keeps showing the optimistic id; the first action must not use it up.
    const engineId = internals.resolveEntryId(record, "optimistic-normal");
    expect(engineId).not.toBe("optimistic-normal");
    expect(internals.resolveEntryId(record, "optimistic-normal")).toBe(engineId);
    expect(internals.resolveEntryId(record, "optimistic-normal")).toBe(engineId);
  });

  it("bounds the alias map, dropping the oldest mapping first", () => {
    const { service } = setup();
    const internals = service as unknown as { aliases: Map<string, string>; setAlias(shown: string, engine: string): void };
    for (let index = 0; index < 2100; index++) internals.setAlias(`shown-${index}`, `engine-${index}`);
    expect(internals.aliases.size).toBe(2000);
    expect(internals.aliases.has("shown-0")).toBe(false);
    expect(internals.aliases.get("shown-2099")).toBe("engine-2099");
  });

  it("makes registration and output persistence failures observable without silently dropping live output", async () => {
    const sides: ObservedSide[] = [];
    const { service, id, root } = setup(observeSide(sides));
    process.env.P2_REJECT_HOST = "1";
    await expect(service.sessionCommand(id, { type: "goal", op: "get" })).rejects.toThrow("host registration rejected");
    delete process.env.P2_REJECT_HOST;
    const blocked = join(root, "not-a-directory"); writeFileSync(blocked, "x"); process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR = blocked;
    const events = await runPrompt(service, id, "/session");
    expect(events.some((event) => event.event.type === "message_end")).toBe(true);
    expect(sides.some((event) => event.method === "native.notice" && event.params.level === "error" && event.params.message?.includes("could not be saved"))).toBe(true);
    expect(existsSync(join(blocked, "unused"))).toBe(false);
  });

  it("keeps prediction on the managed utility and recreates it after settings change", async () => {
    const { service, id, root } = setup();
    await runPrompt(service, id, "normal");
    expect(await service.sessionCommand(id, { type: "predict_word", text: "ac", cursor: 2 })).toEqual({ suffix: "tion" });
    await service.sessionCommand(id, { type: "predict_word_feedback", text: "ac", cursor: 2, suggestion: "tion", accepted: true });
    const before = calls(root).filter((call) => call.type === "predict_word")[0].pid;
    await service.recycleIdle();
    await service.sessionCommand(id, { type: "predict_word", text: "ac", cursor: 2 });
    const predictions = calls(root).filter((call) => call.type === "predict_word");
    expect(predictions[1].pid).not.toBe(before);
    expect(calls(root).filter((call) => call.type === "prompt")[0].pid).not.toBe(before);
    await expect(service.sessionCommand(undefined, { type: "goal", op: "get" })).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  });
});
