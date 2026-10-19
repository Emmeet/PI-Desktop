import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-edit-revert-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target.txt");
  fs.writeFileSync(target, "after");
  const handlers = new Map();
  const prompts = [];
  const owner = { isDestroyed: () => false };
  const event = { sender: { isDestroyed: () => false } };
  const state = { answer: async () => ({ response: 0 }) };
  const labels = { omp: { hostApproval: { title: "Localized access", deny: "Localized deny", allow: "Localized allow", detail: "Localized one-time permission" } }, chat: { ompEditRevert: "Localized revert" } };
  const imports = {
    "node:fs": fs, "node:fs/promises": fsp, "node:os": os, "node:path": path,
    "node:child_process": {}, "@pi-desktop/shared": { IPC }, "../omp-capability-sync": {}, "../data-paths": {}, "../safe-open-external": {},
    "@pi-desktop/i18n": { catalogs: { fixture: labels }, resolveLocale: () => "fixture" },
    electron: { app: { getLocale: () => "fixture" }, BrowserWindow: { fromWebContents: () => owner }, dialog: { async showMessageBox(window, options) { assert.equal(window, owner); prompts.push(options); return state.answer(); } } },
  };
  const file = new URL("../electron/main/ipc/omp-extras-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file.pathname });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => { assert.ok(Object.hasOwn(imports, id), id); return imports[id]; }, module.exports, module);
  module.exports.registerOmpExtrasIpc({ registrar: { handle() {}, handleWithEvent: (key, handler) => handlers.set(key, handler), assertChatWindowSender: (sender) => { if (sender !== event) throw new Error("untrusted sender"); } } });
  return { root, target, prompts, labels, state, invoke: (input = {}, sender = event) => handlers.get(IPC.invoke.ompRevertEdit)(sender, { path: target, oldText: "before", newText: "after", ...input }) };
}

test("edit revert denies native rejection or dismissal without writing", async (t) => {
  const h = harness(t);
  for (const response of [0, -1]) {
    h.state.answer = async () => ({ response });
    await assert.rejects(h.invoke(), { errorCode: "PERMISSION_DENIED" });
    assert.equal(fs.readFileSync(h.target, "utf8"), "after");
  }
  assert.equal(h.prompts[0].defaultId, 0);
  assert.equal(h.prompts[0].cancelId, 0);
  assert.equal(h.prompts[0].message, h.labels.chat.ompEditRevert);
  assert.match(h.prompts[0].detail, new RegExp(h.target));
  assert.deepEqual(h.prompts[0].buttons, [h.labels.omp.hostApproval.deny, h.labels.omp.hostApproval.allow]);
});

test("edit revert requires trusted sender and explicit native consent before writing", async (t) => {
  const h = harness(t);
  await assert.rejects(h.invoke({}, {}), /untrusted sender/);
  assert.equal(h.prompts.length, 0);
  h.state.answer = async () => { assert.equal(fs.readFileSync(h.target, "utf8"), "after"); return { response: 1 }; };
  assert.deepEqual(await h.invoke(), { ok: true });
  assert.equal(h.prompts.length, 1);
  assert.equal(fs.readFileSync(h.target, "utf8"), "before");
});

test("edit revert rejects changes made while native consent is pending", async (t) => {
  const h = harness(t);
  h.state.answer = async () => { fs.writeFileSync(h.target, "newer edit"); return { response: 1 }; };
  await assert.rejects(h.invoke(), { errorCode: "CONFLICT" });
  assert.equal(fs.readFileSync(h.target, "utf8"), "newer edit");
});

test("edit revert rejects path redirection after consent without touching either file", async (t) => {
  const h = harness(t);
  const other = path.join(h.root, "other.txt");
  fs.writeFileSync(other, "after");
  h.state.answer = async () => { fs.unlinkSync(h.target); fs.symlinkSync(other, h.target); return { response: 1 }; };
  await assert.rejects(h.invoke(), { errorCode: "CONFLICT" });
  assert.equal(fs.readFileSync(other, "utf8"), "after");
});
