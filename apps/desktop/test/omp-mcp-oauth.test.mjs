import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}
const policy = load("../electron/main/safe-open-external.ts", {});

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-oauth-test-"));
  const dataDir = path.join(root, "data");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter();
  const children = [];
  const dirs = [];
  const api = load("../electron/main/ipc/omp-extras-ipc.ts", {
    "node:fs": { ...fs, mkdtempSync: () => { const dir = fs.mkdtempSync(path.join(root, "helper-")); dirs.push(dir); return dir; } },
    "node:fs/promises": fsp, "node:os": os, "node:path": path,
    electron: { app }, "@pi-desktop/shared": { IPC }, "@pi-desktop/i18n": {},
    "../data-paths": { desktopDataDir: () => dataDir }, "../safe-open-external": policy,
    "../omp-capability-sync": { ompPackageDir: () => "/isolated/omp", bunBinary: () => "/isolated/bun" },
    "node:child_process": { spawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.write = () => true;
      child.kills = 0;
      child.kill = () => { ++child.kills; return true; };
      children.push(child);
      return child;
    } },
  });
  return { ...api, root, dataDir, app, children, dirs };
}

test("failed spawn cleans helper files without requiring an exit event", async (t) => {
  const h = harness(t);
  const pending = h.runOmpMcpOAuth("https://mcp.example", () => {});
  const rejected = assert.rejects(pending, /spawn ENOENT/);
  h.children[0].emit("error", new Error("spawn ENOENT"));
  await rejected;
  assert.equal(fs.existsSync(h.dirs[0]), false);
  assert.equal(h.cancelOmpMcpOAuth(), false);
  assert.equal(h.app.listenerCount("will-quit"), 0);
});

test("OAuth consumes buffered success through close rather than exiting before stdout drains", async (t) => {
  const h = harness(t);
  const pending = h.runOmpMcpOAuth("https://mcp.example", () => {});
  // Install a rejection observer before emitting exit so broken implementations do not leak a rejection.
  pending.catch(() => {});
  const child = h.children[0];
  child.emit("exit", 0, null);
  child.stdout.emit("data", Buffer.from('{"type":"done"}\n'));
  child.emit("close", 0, null);
  await pending;
  assert.equal(h.ompMcpSignedIn("https://mcp.example"), true);
  assert.equal(fs.existsSync(h.dirs[0]), false);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(h.app.listenerCount("will-quit"), 0);
});

test("OAuth marker persistence errors reject instead of escaping an event callback", async (t) => {
  const h = harness(t);
  fs.writeFileSync(h.dataDir, "not a directory");
  const pending = h.runOmpMcpOAuth("https://mcp.example", () => {});
  const rejected = assert.rejects(pending, /EEXIST|ENOTDIR/);
  const child = h.children[0];
  child.stdout.emit("data", Buffer.from('{"type":"done"}\n'));
  assert.doesNotThrow(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
  await rejected;
  assert.equal(fs.existsSync(h.dirs[0]), false);
});

test("OAuth rejects non-HTTP authorization URLs before exposing them to the browser callback", async (t) => {
  const h = harness(t);
  const events = [];
  const pending = h.runOmpMcpOAuth("https://mcp.example", (event) => events.push(event));
  const rejected = assert.rejects(pending, /authorization|URL/i);
  const child = h.children[0];
  child.stdout.emit("data", Buffer.from('{"type":"auth","url":"file:///tmp/unsafe"}\n'));
  child.emit("exit", 1, null); child.emit("close", 1, null);
  await rejected;
  assert.deepEqual(events, []);
});

test("OAuth cancellation timer is cleared on close and quit stops an active helper", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  const pending = h.runOmpMcpOAuth("https://mcp.example", () => {});
  const rejected = assert.rejects(pending);
  const child = h.children[0];
  assert.equal(h.cancelOmpMcpOAuth(), true);
  child.emit("exit", 1, null); child.emit("close", 1, null);
  await rejected;
  t.mock.timers.tick(2000);
  assert.equal(child.kills, 0, "a settled helper must not retain its forced-kill timer");
  const next = h.runOmpMcpOAuth("https://mcp.example", () => {});
  const nextRejected = assert.rejects(next);
  const nextChild = h.children[1];
  h.app.emit("will-quit");
  assert.equal(nextChild.kills, 1);
  nextChild.emit("exit", 1, null); nextChild.emit("close", 1, null);
  await nextRejected;
  assert.equal(h.app.listenerCount("will-quit"), 0);
});

test("MCP browser launch failure reports opened false instead of claiming success", async () => {
  const handlers = new Map();
  const events = [];
  let finish;
  const { registerMcpIpc } = load("../electron/main/ipc/mcp-ipc.ts", {
    "@pi-desktop/shared": { IPC }, "node:crypto": { randomUUID: () => "login" },
    electron: { shell: { async openExternal() { throw new Error("browser unavailable"); } } },
    "../safe-open-external": policy,
    "./omp-extras-ipc": { runOmpMcpOAuth: async (_url, emit) => { emit({ kind: "authUrl", url: "https://auth.example/" }); await new Promise((resolve) => { finish = resolve; }); } },
  });
  registerMcpIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ async call() { return { servers: [{ id: "server", transport: "http", url: "https://mcp.example" }] }; } }),
    sendToRenderer: (_channel, event) => events.push(event),
  });
  await handlers.get(IPC.invoke.mcpOauthStart)({ id: "server" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.find((event) => event.kind === "authUrl")?.opened, false);
  finish();
});
