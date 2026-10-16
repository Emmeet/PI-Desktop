import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import { isOmpApprovalMode, normalizeOmpApprovalMode } from "../../../packages/shared/src/omp-approval.ts";

// Execute production handlers; substitute only their external process/native boundaries.
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
const shared = { IPC, ErrorCodes, isOmpApprovalMode, normalizeOmpApprovalMode };

function harness(stored = {}) {
  const handlers = new Map();
  const calls = [];
  const globalConfig = { "tools.approvalMode": "yolo", "tools.approval": { read: "allow" } };
  let processMode = "write";
  const runOmpConfig = async (args) => {
    calls.push({ boundary: "omp-config", args });
    assert.notEqual(args[1], "tools.approvalMode", "Desktop must never read or write global approvalMode");
    if (args[0] === "get") return JSON.stringify({ value: globalConfig[args[1]] });
    globalConfig[args[1]] = JSON.parse(args[2]);
    return "{}";
  };
  const host = { binaryPath: "/isolated/host", async call(method, input) {
    calls.push({ boundary: "host", method, input });
    if (method === "settings.get") return structuredClone(stored);
    if (method === "settings.set") { Object.assign(stored, input); return structuredClone(stored); }
    assert.fail(`Unexpected host call: ${method}`);
  } };
  const runs = [];
  const sidecar = { async call(method, input) {
    calls.push({ boundary: "sidecar", method, input });
    if (method === "sidecar.configure") processMode = normalizeOmpApprovalMode(input.ompApprovalMode);
    if (method === "agent.prompt") { runs.push({ mode: processMode, ...input }); return { accepted: true, turnId: "turn" }; }
    return { ok: true };
  } };
  const registrar = { handle: (channel, handler) => handlers.set(channel, handler) };
  const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
    electron: { shell: {} }, "node:fs": fs, "node:path": path,
    "@pi-desktop/shared": shared, "../importers": {},
    "../omp-capability-sync": { runOmpConfig },
    "../services/session-collaboration": {}, "../services/session-search": {},
  });
  registerSessionIpc({ registrar, getHost: () => host, getSidecar: () => sidecar });
  const { registerSettingsIpc } = load("../electron/main/ipc/settings-ipc.ts", {
    "@pi-desktop/shared": shared,
    "../network-proxy": { currentSystemProxyRelayUrl: () => undefined },
  });
  registerSettingsIpc({
    registrar, getHost: () => host, getSidecar: () => sidecar, dataDir: "/isolated",
    normalizeSettings: (value) => value, validateSettingsWrite: (value) => value,
    applyNetworkProxyFromAppSettings: async () => {}, currentNetworkProxy: () => ({}),
    applyApplicationMenuSettings() {}, applyDeveloperMode() {}, applyUpdatePreference() {},
    applyKeepAwakeWhileRunning() {}, applyPreventScreenSleep() {},
  });
  const { registerAgentIpc } = load("../electron/main/ipc/agent-ipc.ts", {
    "node:path": path, "@pi-desktop/shared": shared, "@pi-desktop/agent-runtime": {},
    "@pi-desktop/host-runtime": {}, "../composer-mcp": {}, "../prompt-attachments": {}, "../session-references": {},
  });
  registerAgentIpc({ registrar, getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => null,
    setNotificationViewingSessionId() {} });
  return { invoke: (operation, input) => handlers.get(IPC.invoke[operation])(input), stored, calls, globalConfig, runs };
}

test("desktop mode defaults to write independently of global yolo or invalid stored values", async () => {
  for (const value of [undefined, null, "unknown", 42]) {
    const h = harness(value === undefined ? {} : { ompApprovalMode: value });
    const result = await h.invoke("ompApprovalGet");
    assert.equal(result.mode, "write");
    assert.deepEqual(result.rules, { read: "allow" });
    assert.equal(h.globalConfig["tools.approvalMode"], "yolo");
    await h.invoke("agentPrompt", { sessionId: "native-pi:existing", content: "read" });
    assert.equal(h.runs[0].mode, "write");
  }
});

test("settings modes persist separately and configure the next native run", async () => {
  const h = harness({ theme: "dark" });
  for (const mode of ["yolo", "always-ask", "write"]) {
    await h.invoke("ompApprovalSet", { mode });
    assert.equal(h.stored.ompApprovalMode, mode);
    assert.equal(h.stored.theme, "dark");
    assert.equal((await h.invoke("ompApprovalGet")).mode, mode);
    assert.equal((await harness(h.stored).invoke("ompApprovalGet")).mode, mode, "survives a new IPC registration");
    await h.invoke("agentPrompt", { sessionId: "native-pi:existing", content: "read then edit" });
    assert.equal(h.runs.at(-1).mode, mode);
    assert.equal(h.globalConfig["tools.approvalMode"], "yolo");
  }
  assert.equal(h.calls.filter((call) => call.boundary === "omp-config" && call.args[0] === "set").length, 0);
});

test("per-tool rules retain omp storage without changing global mode", async () => {
  const h = harness();
  await h.invoke("ompApprovalSet", { mode: "always-ask", rules: { bash: "prompt", read: "deny", edit: "allow" } });
  assert.deepEqual((await h.invoke("ompApprovalGet")).rules, { bash: "prompt", read: "deny", edit: "allow" });
  assert.equal(h.globalConfig["tools.approvalMode"], "yolo");
  await h.invoke("ompApprovalSet", { rules: {} });
  assert.deepEqual((await h.invoke("ompApprovalGet")).rules, {});
  assert.equal(h.stored.ompApprovalMode, "always-ask");
});

test("invalid mixed requests do not partly persist a new mode", async () => {
  for (const rules of [null, [], "allow", { bash: "invalid" }, { "bad tool": "allow" }]) {
    const h = harness();
    await assert.rejects(h.invoke("ompApprovalSet", { mode: "yolo", rules }), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    assert.deepEqual(h.stored, {});
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  await assert.rejects(h.invoke("ompApprovalSet", { mode: "unknown", rules: { bash: "allow" } }), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  assert.equal(h.calls.length, 0);
});

test("general settings writes preserve and propagate desktop approval mode", async () => {
  const h = harness({ ompApprovalMode: "always-ask" });
  await h.invoke("settingsSet", { theme: "light" });
  assert.equal(h.stored.ompApprovalMode, "always-ask");
  await h.invoke("agentPrompt", { sessionId: "native-pi:existing", content: "read" });
  assert.equal(h.runs[0].mode, "always-ask");
  await h.invoke("settingsSet", { ompApprovalMode: "yolo" });
  await h.invoke("agentPrompt", { sessionId: "native-pi:existing", content: "edit" });
  assert.equal(h.runs[1].mode, "yolo");
  await assert.rejects(h.invoke("settingsSet", { ompApprovalMode: "unknown" }), { errorCode: "INVALID_PARAMS" });
  assert.equal(h.stored.ompApprovalMode, "yolo");
  assert.equal(h.globalConfig["tools.approvalMode"], "yolo");
});
