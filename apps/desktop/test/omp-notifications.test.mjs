import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";

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

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-notifications-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { createOmpNotificationStore } = load("../electron/main/omp-notifications.ts", {
    "node:crypto": { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}` },
    "node:fs": fs, "node:path": path,
  });
  return { store: createOmpNotificationStore(dataDir), file: path.join(dataDir, "omp-notifications.json") };
}

const completion = (turnId) => ({ kind: "task.completed", sessionId: "native-pi:a", sessionTitle: "Chat", turnId });

test("turns finishing in the same tick each keep their own notification", async (t) => {
  const h = harness(t);
  // Two sessions (or a subagent and its parent) end in the same tick; an
  // unserialized read-modify-write would drop the first row.
  const [first, second] = await Promise.all([h.store.add(completion("turn-1")), h.store.add(completion("turn-2"))]);
  assert.ok(first && second);
  const rows = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.deepEqual(rows.map((row) => row.turnId).sort(), ["turn-1", "turn-2"]);
  // Both mutations must have run in call order: the second sees the first's row.
  assert.equal(rows[1].turnId, "turn-1");
});

test("a mutation that fails does not poison later writes", async (t) => {
  const h = harness(t);
  await h.store.add(completion("turn-1"));
  // Make the next write fail the way a full disk or a bad JSON file would.
  fs.writeFileSync(h.file, "{ not json");
  await h.store.add(completion("turn-2"));
  const rows = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.deepEqual(rows.map((row) => row.turnId), ["turn-2"]);
  assert.equal(h.store.merge({}, {}).unreadCount, 1);
});

test("the same turn finishing twice is still one notification", async (t) => {
  const h = harness(t);
  const [first, second] = await Promise.all([h.store.add(completion("turn-1")), h.store.add(completion("turn-1"))]);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).length, 1);
});

test("the unread count matches the rows a limited list actually delivered", async (t) => {
  const h = harness(t);
  await h.store.add(completion("turn-1"));
  await h.store.add(completion("turn-2"));
  await h.store.add({ ...completion("turn-3"), kind: "task.failed", errorCode: "OMP_RUNTIME_ERROR" });
  const page = h.store.merge({ notifications: [], unreadCount: 0 }, { limit: 1 });
  assert.equal(page.notifications.length, 1);
  // The badge counts what is unread, not what the truncated page happens to show.
  assert.equal(page.unreadCount, 3);
});

test("marking one row read leaves the others unread", async (t) => {
  const h = harness(t);
  await h.store.add(completion("turn-1"));
  await h.store.add(completion("turn-2"));
  const rows = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(await h.store.markRead(rows[0].id), true);
  assert.equal(h.store.merge({}, { unreadOnly: true }).notifications.length, 1);
  await h.store.markAllRead();
  assert.equal(h.store.merge({}, { unreadOnly: true }).notifications.length, 0);
});
