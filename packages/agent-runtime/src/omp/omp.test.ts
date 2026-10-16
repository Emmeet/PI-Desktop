import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmpNotFoundError, resolveOmpBinary } from "./binary.js";
import { parseOmpSession } from "./session-store.js";
import { OmpSessionService } from "./service.js";

const roots: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-test-"));
  roots.push(root);
  return root;
}

const SESSION = [
  { type: "title", v: 1, title: "", updatedAt: "2026-10-12T07:09:34.108Z" },
  { type: "session", version: 3, id: "sid-1", timestamp: "2026-10-12T07:09:34.108Z", cwd: "/tmp" },
  { type: "model_change", id: "m", parentId: null, timestamp: "2026-10-12T07:09:34.214Z", model: "mock/mock-1" },
  { type: "message", id: "u", parentId: "m", timestamp: "2026-10-12T07:09:35.000Z", message: { role: "user", content: [{ type: "text", text: "run it" }], attribution: "user" } },
  { type: "message", id: "a", parentId: "u", timestamp: "2026-10-12T07:09:36.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } }], provider: "mock", model: "mock-1", stopReason: "toolUse" } },
  { type: "custom", customType: "tool_execution_start", id: "x", parentId: "a", timestamp: "2026-10-12T07:09:36.100Z", data: {} },
  { type: "message", id: "t", parentId: "x", timestamp: "2026-10-12T07:09:37.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false } },
];

describe("omp session store", () => {
  it("projects the active branch, tool args, and model", () => {
    const dir = tmp();
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${SESSION.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const parsed = parseOmpSession(file)!;
    expect(parsed).toMatchObject({ sessionId: "sid-1", cwd: "/tmp", providerId: "mock", modelId: "mock-1", title: "run it" });
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(parsed.messages[2]).toMatchObject({ toolName: "bash", toolArgs: { command: "echo hi" }, toolStatus: "success" });
  });
});

describe("omp binary resolution", () => {
  it("fails with OMP_NOT_FOUND and an install hint", () => {
    expect(() => resolveOmpBinary({ PI_DESKTOP_OMP_BIN: "/definitely/missing/omp" })).toThrow(OmpNotFoundError);
    try {
      resolveOmpBinary({ PI_DESKTOP_OMP_BIN: "/definitely/missing/omp" });
    } catch (error) {
      expect((error as OmpNotFoundError).errorCode).toBe("OMP_NOT_FOUND");
      expect((error as Error).message).toContain("bun install -g @oh-my-pi/pi-coding-agent");
    }
  });
});

// A tiny stand-in for `omp --mode rpc` that speaks the same JSONL frames.
const FAKE_OMP = `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("18.10.0\\n"); process.exit(0); }
if (process.argv[2] === "config") {
  process.stdout.write(JSON.stringify({ key: "modelRoles", value: process.env.FAKE_OMP_ROLES ? JSON.parse(process.env.FAKE_OMP_ROLES) : {} }));
  process.exit(0);
}
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_OMP_SESSIONS;
const file = path.join(dir, "-proj", "fake.jsonl");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (process.env.FAKE_OMP_LOG) fs.appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ cmd: cmd.type, provider: cmd.provider, modelId: cmd.modelId, level: cmd.level, argv: process.argv.slice(2) }) + "\\n");
    if (cmd.type === "get_available_models") out({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { models: [{ provider: "p1", id: "m1", name: "Model One", reasoning: true, thinking: { efforts: ["low", "high", "bogus"] }, apiKey: "SECRET", headers: { Authorization: "x" } }] } });
    if (cmd.type === "set_model" || cmd.type === "set_thinking_level") out({ type: "response", id: cmd.id, command: cmd.type, success: true });
    if (["set_ask_dialog", "set_subagent_subscription", "set_host_tools", "set_host_uri_schemes", "set_fast_mode"].includes(cmd.type)) out({ type: "response", id: cmd.id, command: cmd.type, success: true });
    if (cmd.type === "get_state") out({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile: file } });
    if (cmd.type === "prompt") {
      out({ type: "response", id: cmd.id, command: "prompt", success: true });
      const user = { role: "user", content: [{ type: "text", text: cmd.message }], attribution: "user" };
      const asst = { role: "assistant", content: [{ type: "text", text: "echo: " + cmd.message }], provider: "fake", model: "m", stopReason: "stop" };
      out({ type: "agent_start" });
      out({ type: "message_end", message: user, messageId: "msg-1" });
      out({ type: "message_start", message: { ...asst, content: [] } });
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", partial: asst } });
      out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "true" } });
      out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false });
      out({ type: "message_end", message: asst, messageId: "msg-2" });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        { type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() },
        { type: "message", id: "u", parentId: null, timestamp: new Date().toISOString(), message: user },
        { type: "message", id: "a", parentId: "u", timestamp: new Date().toISOString(), message: asst },
      ].map((e) => JSON.stringify(e)).join("\\n") + "\\n");
      out({ type: "agent_end", messages: [] });
      out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("OmpSessionService", () => {
  it("creates a session, streams a turn through the omp RPC process, and lists the persisted file", async () => {
    const root = tmp();
    const bin = join(root, "omp");
    writeFileSync(bin, FAKE_OMP);
    chmodSync(bin, 0o755);
    const agentDir = join(root, "agent");
    const sessionRoot = join(agentDir, "sessions");
    mkdirSync(sessionRoot, { recursive: true });
    const project = join(root, "project");
    mkdirSync(project);
    process.env.PI_DESKTOP_OMP_BIN = bin;
    process.env.FAKE_OMP_SESSIONS = sessionRoot;

    const service = new OmpSessionService({ agentDir, sessionRoot });
    const created = service.create({ projectPath: project });
    expect(created).toMatchObject({ source: "pi-native", nativeHarness: "omp", capabilities: { canPrompt: true } });

    const events: string[] = [];
    const ended = new Promise<void>((resolve) => {
      void service.prompt(created.id, "hello", (envelope) => {
        events.push(envelope.event.type);
        if (envelope.event.type === "agent_end") resolve();
      }, "optimistic-1");
    });
    await ended;
    expect(events).toEqual(expect.arrayContaining([
      "agent_start", "user_message_persisted", "message_start", "message_update", "tool_start", "tool_end", "message_end", "agent_end",
    ]));
    const sessions = await service.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: created.id, title: "hello", providerId: "fake", modelId: "m" });
    expect(service.detail(created.id)?.messages.map((message) => message.content)).toEqual(["hello", "echo: hello"]);
    service.disposeAll();
  });

  it("reports a missing omp binary as a turn error", async () => {
    const root = tmp();
    process.env.PI_DESKTOP_OMP_BIN = join(root, "missing-omp");
    const service = new OmpSessionService({ agentDir: join(root, "agent") });
    const created = service.create({ projectPath: root });
    await expect(service.prompt(created.id, "hi", () => undefined)).rejects.toMatchObject({ errorCode: "OMP_NOT_FOUND" });
  });
});

describe("omp model selection", () => {
  it("lists omp's models without secrets and applies + remembers a chosen model", async () => {
    const root = tmp();
    const bin = join(root, "omp");
    writeFileSync(bin, FAKE_OMP);
    chmodSync(bin, 0o755);
    const sessionRoot = join(root, "agent", "sessions");
    mkdirSync(sessionRoot, { recursive: true });
    const log = join(root, "log.jsonl");
    process.env.PI_DESKTOP_OMP_BIN = bin;
    process.env.FAKE_OMP_SESSIONS = sessionRoot;
    process.env.FAKE_OMP_LOG = log;
    process.env.PI_DESKTOP_OMP_PREFS = join(root, "prefs.json");
    delete process.env.PI_DESKTOP_OMP_MODEL;

    const service = new OmpSessionService({ agentDir: join(root, "agent"), sessionRoot });
    const catalog = await service.listModels();
    expect(catalog.models).toEqual([{ provider: "p1", id: "m1", name: "Model One", reasoning: true, fast: false, thinkingLevels: ["off", "low", "high"] }]);

    const created = service.create({ projectPath: root });
    await service.setModel({ sessionId: created.id, provider: "p1", modelId: "m1" });
    await service.setThinkingLevel({ sessionId: created.id, level: "high" });
    expect(JSON.parse(readFileSync(join(root, "prefs.json"), "utf8"))).toEqual({ model: { provider: "p1", modelId: "m1" }, thinkingLevel: "high" });

    await new Promise<void>((resolve) => {
      void service.prompt(created.id, "hi", (envelope) => { if (envelope.event.type === "agent_end") resolve(); });
    });
    await service.setModel({ sessionId: created.id, provider: "p1", modelId: "m2" });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const prompt = calls.find((call) => call.cmd === "prompt");
    expect(prompt.argv).toEqual(expect.arrayContaining(["--model", "p1/m1", "--thinking", "high"]));
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ cmd: "set_model", provider: "p1", modelId: "m2" })]));
    expect(service.detail(created.id)).toMatchObject({ providerId: "p1", modelId: "m2", thinkingLevel: "high" });

    // New chats ignore the last pick and start on omp's `default` role (model + level).
    process.env.FAKE_OMP_ROLES = JSON.stringify({ default: "p1/m1:low" });
    const again = new OmpSessionService({ agentDir: join(root, "agent"), sessionRoot });
    await again.refreshDefaultRole();
    expect(again.newSessionModel()).toEqual({ provider: "p1", modelId: "m1" });
    expect(again.newSessionThinking()).toBe("low");
    await again.setModel({ provider: "p1", modelId: "m2" });
    expect(again.detail(again.create({ projectPath: root }).id)).toMatchObject({ providerId: "p1", modelId: "m2" });
    expect(again.newSessionModel()).toEqual({ provider: "p1", modelId: "m1" });
    delete process.env.FAKE_OMP_ROLES;
    service.disposeAll();
  });
});
