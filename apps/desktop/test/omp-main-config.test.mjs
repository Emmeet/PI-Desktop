import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

function capabilityHarness(initial = {}) {
  const values = { "task.disabledAgents": [], "skills.ignoredSkills": [], ...initial };
  let active = 0;
  let peak = 0;
  let failNext = false;
  const calls = [];
  const engine = load("../electron/main/omp-capability-sync.ts", {
    "@pi-desktop/agent-runtime/omp-binary": { resolveOmpBinary: () => "/isolated/omp" },
    "node:fs": fs, "node:os": os, "node:path": path,
    "node:child_process": { execFile(binary, args, options, callback) {
      calls.push(args);
      peak = Math.max(peak, ++active);
      const fail = failNext;
      failNext = false;
      const output = args[1] === "get" ? JSON.stringify({ value: values[args[2]] }) : "{}";
      setImmediate(() => {
        --active;
        if (!fail && args[1] === "set") values[args[2]] = JSON.parse(args[3]);
        callback(fail ? new Error("fixture failure") : null, output, "");
      });
    } },
  });
  return { engine, values, calls, get peak() { return peak; }, fail() { failNext = true; } };
}

function extrasHarness() {
  const handlers = new Map();
  const calls = [];
  const values = {};
  const { registerOmpExtrasIpc } = load("../electron/main/ipc/omp-extras-ipc.ts", {
    "node:fs": fs, "node:fs/promises": fsp, "node:os": os, "node:path": path,
    "node:child_process": {}, electron: {}, "@pi-desktop/shared": { IPC }, "@pi-desktop/i18n": {},
    "../data-paths": {}, "../safe-open-external": {},
    "../omp-capability-sync": {
      async runOmp(args) { calls.push(args); return JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]))); },
      async runOmpConfig(args) {
        calls.push(args);
        if (args[0] === "list") return JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])));
        values[args[1]] = JSON.parse(args[2]);
      },
    },
  });
  registerOmpExtrasIpc({ registrar: { handle: (key, handler) => handlers.set(key, handler), handleWithEvent() {} } });
  return { invoke: (input) => handlers.get(IPC.invoke.ompConfigSet)(input), calls };
}

test("settings reject inherited keys and non-scalar enum or fractional count inputs before invoking OMP", async () => {
  for (const input of [
    { key: "constructor", value: "anything" }, { key: "toString", value: "anything" },
    { key: "__proto__", value: "anything" },
    { key: "symbolPreset", value: ["ascii"] },
    { key: "commit.cacheTtlDays", value: 0.5 },
  ]) {
    const h = extrasHarness();
    await assert.rejects(h.invoke(input), { errorCode: "INVALID_ARGUMENT" });
    assert.equal(h.calls.length, 0);
  }
  const h = extrasHarness();
  assert.deepEqual(await h.invoke({ key: "commit.cacheTtlDays", value: 0 }), { ok: true, value: 0 });
});

test("config commands serialize subprocess writes and recover after a rejected write", async () => {
  const h = capabilityHarness();
  h.fail();
  const failed = assert.rejects(h.engine.runOmpConfig(["set", "a", "true"]), /fixture failure/);
  await Promise.all([failed, h.engine.runOmpConfig(["set", "b", "false"]), h.engine.runOmpConfig(["set", "c", "true"])]);
  assert.equal(h.peak, 1, "OMP config subprocesses must not overwrite each other's read-modify-write");
  assert.equal(h.values.b, false);
  assert.equal(h.values.c, true);
});

test("concurrent agent toggles retain both changes and unrelated disabled agents", async () => {
  const h = capabilityHarness({ "task.disabledAgents": ["user-owned"] });
  await Promise.all([h.engine.setOmpAgentEnabled("alpha", false), h.engine.setOmpAgentEnabled("beta", false)]);
  assert.deepEqual(h.values["task.disabledAgents"], ["user-owned", "alpha", "beta"]);
  await Promise.all([h.engine.setOmpAgentEnabled("alpha", true), h.engine.setOmpAgentEnabled("gamma", false)]);
  assert.deepEqual(h.values["task.disabledAgents"], ["user-owned", "beta", "gamma"]);
});

test("a transient host read failure keeps the project's mirrored capabilities instead of emptying them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-main-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.mkdirSync(dataDir);
  const manifestPath = path.join(dataDir, "omp-capability-sync.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    agentsUserScanOff: true,
    projectMcp: { [project]: ["existing"] },
    projectAgents: { [project]: ["existing"] },
    projectSkills: { [project]: ["existing"] },
  }));
  fs.writeFileSync(path.join(project, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { existing: { url: "https://mcp.example" } } }, null, 2));
  let failing = true;
  const host = { async call(method, params) {
    if (method === "projects.list") return { projects: [{ path: project }] };
    // Every project-scoped read fails once, as a busy or restarting host would.
    if (params?.projectPath === project && failing) throw new Error("host busy");
    if (method === "mcp.active") return { servers: [] };
    if (method === "agents.active") return { subagents: [] };
    if (method === "skills.active") return { skills: [] };
    assert.fail(`unexpected host call: ${method}`);
  } };
  const h = capabilityHarness();
  await h.engine.syncOmpCapabilities(host, { dataDir, agentDir });
  // The mirrored server survives, and the manifest still owns it so the next
  // successful projection can reconcile instead of having nothing to restore.
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, ".omp", "mcp.json"), "utf8")).mcpServers.existing.url, "https://mcp.example");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest.projectMcp, { [project]: ["existing"] });
  assert.deepEqual(manifest.projectAgents, { [project]: ["existing"] });
  assert.deepEqual(manifest.projectSkills, { [project]: ["existing"] });
});

test("capability projection preserves project ignore entries when managed skills are disabled and re-enabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-main-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.mkdirSync(dataDir);
  const settingsPath = path.join(project, ".omp", "settings.json");
  const manifestPath = path.join(dataDir, "omp-capability-sync.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ skills: { ignoredSkills: ["user-only", "shared"], customFlag: true }, custom: 1 }));
  fs.writeFileSync(manifestPath, JSON.stringify({ agentsUserScanOff: true }));
  let disabled = true;
  const host = { async call(method) {
    if (method === "projects.list") return { projects: [{ path: project }] };
    if (method === "mcp.active") return { servers: [] };
    if (method === "agents.active") return { subagents: [] };
    if (method === "skills.active") return { skills: [] };
    if (method === "skills.list") return { skills: ["managed", "shared"].map((name) => ({ id: name, name, enabled: !disabled, level: "project", path: path.join(project, ".agents", "skills", name, "SKILL.md") })) };
    assert.fail(`unexpected host call: ${method}`);
  } };
  const h = capabilityHarness({ "skills.ignoredSkills": ["global-only"] });
  await h.engine.syncOmpCapabilities(host, { dataDir, agentDir });
  const first = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(new Set(first.skills.ignoredSkills), new Set(["user-only", "shared", "global-only", "managed"]));
  assert.equal(first.skills.customFlag, true);
  assert.equal(first.custom, 1);
  // Preserve edits made in OMP itself between Desktop projections, too.
  first.skills.ignoredSkills.push("later-user-entry");
  fs.writeFileSync(settingsPath, JSON.stringify(first));
  disabled = false;
  await h.engine.syncOmpCapabilities(host, { dataDir, agentDir });
  const second = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(new Set(second.skills.ignoredSkills), new Set(["user-only", "shared", "later-user-entry"]));
  assert.equal(second.skills.customFlag, true);
  assert.equal(second.custom, 1);
});

test("generic renderer commands cannot bypass the native HTML export save dialog", async () => {
  const handlers = new Map();
  const calls = [];
  const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
    electron: { shell: {} }, "node:fs": fs, "node:path": path,
    "@pi-desktop/shared": { IPC }, "../importers": {}, "../omp-capability-sync": {},
    "../services/session-collaboration": {}, "../services/session-search": {},
  });
  registerSessionIpc({ registrar: { handle: (key, handler) => handlers.set(key, handler) }, getHost: () => null,
    getSidecar: () => ({ async call(method, input) { calls.push({ method, input }); return { ok: true }; } }) });
  const invoke = (params) => handlers.get(IPC.invoke.ompCall)({ method: "omp.session.command", params });
  await assert.rejects(invoke({ sessionId: "native-pi:test", command: { type: "export_html", outputPath: "/unapproved.html" } }), { errorCode: "PERMISSION_DENIED" });
  assert.equal(calls.length, 0);
  const params = { sessionId: "native-pi:test", command: { type: "goal", op: "get" } };
  assert.deepEqual(await invoke(params), { ok: true });
  assert.deepEqual(calls, [{ method: "omp.session.command", input: params }]);
});
