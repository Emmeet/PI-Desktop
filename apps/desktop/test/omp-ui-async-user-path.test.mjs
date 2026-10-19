import assert from "node:assert/strict";
import test from "node:test";
import { rendererProbeUnavailable, runOmpRendererProbe } from "./helpers/omp-renderer-probe.mjs";

// Deferred IPC replies exercise production components, not duplicated state machines.
const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { OmpSubagentDock } from "./apps/desktop/src/features/omp/OmpSubagentDock";
import { OmpLoopDock } from "./apps/desktop/src/features/omp/OmpSessionActions";
import { OmpBranchTreeButton } from "./apps/desktop/src/features/omp/OmpBranchTree";
import { OmpSessionTotals } from "./apps/desktop/src/features/omp/OmpSessionTotals";
import { OmpApprovalSection } from "./apps/desktop/src/features/settings/OmpApprovalSection";
import { OmpRolesPage } from "./apps/desktop/src/features/settings/OmpRolesPage";
import { OmpAccountsSection } from "./apps/desktop/src/features/settings/OmpAccountsSection";
import { useAppStore } from "./apps/desktop/src/stores/app-store";

const root = createRoot(document.getElementById("root"));
const mount = (node) => flushSync(() => root.render(node));
const check = (value, label) => { if (!value) throw Error(label); };
const nativeTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const nativeInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
const pause = () => new Promise((resolve) => nativeTimeout(resolve, 0));
async function until(predicate, label) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) { if (predicate()) return; await pause(); }
  throw Error("Timeout: " + label);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fill(node, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
  flushSync(() => node.dispatchEvent(new Event("input", { bubbles: true })));
}
const click = (node) => { check(node, "click target exists"); flushSync(() => node.click()); };
const button = (label, container = document) => [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
const submit = (form) => flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const listeners = new Set();
const emit = (method, params) => flushSync(() => { for (const listener of listeners) listener({ method, params }); });
const timers = new Map();
let timerId = 1000000;
for (const [name, native, repeat] of [["setTimeout", nativeTimeout, false], ["setInterval", nativeInterval, true]]) {
  window[name] = (callback, delay, ...args) => {
    if (delay !== 2500) return native(callback, delay, ...args);
    const id = ++timerId; timers.set(id, { callback: () => callback(...args), repeat }); return id;
  };
}
window.clearTimeout = (id) => { if (!timers.delete(id)) nativeClearTimeout(id); };
window.clearInterval = (id) => { if (!timers.delete(id)) nativeClearInterval(id); };
async function tick() {
  flushSync(() => { for (const [id, timer] of [...timers]) { if (!timer.repeat) timers.delete(id); timer.callback(); } });
  await pause();
}
let invoke;
window.piDesktop = {
  platform: "linux",
  on(_channel, listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async invoke(channel, args) { return { ok: true, data: await invoke(channel, args) }; },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
const toasts = [];
useAppStore.setState({ showToast: (message) => toasts.push(message), sessions: [], messages: [], settings: {}, activeSessionId: "native-pi:a" });
const agent = { id: "worker", index: 0, agent: "Reviewer", status: "running", task: "Review", updatedAt: 1 };
const message = (content) => ({ id: "reply", role: "assistant", content, createdAt: "2026-10-18T00:00:00Z" });
const view = () => document.querySelector('button[title="' + i18n.t("chat.ompSubagents.view") + '"]');

async function eventWinsSnapshot() {
  const initial = deferred();
  invoke = async (_channel, args) => args.method === "omp.subagents.list" ? initial.promise : {};
  mount(<OmpSubagentDock sessionId="native-pi:a" />);
  emit("native.subagents.changed", { sessionId: "native-pi:a", subagents: [agent] });
  check(document.querySelector(".omp-subagent-name")?.textContent === "Reviewer", "event renders live worker");
  initial.resolve({ subagents: [] }); await pause(); await pause();
  check(document.querySelector(".omp-subagent-name")?.textContent === "Reviewer", "late initial list must not erase newer event");
}

async function pollingLifecycle() {
  const requests = [];
  invoke = async (_channel, args) => {
    if (args.method === "omp.subagents.list") return { subagents: [agent] };
    if (args.method === "omp.subagents.messages") { const request = deferred(); requests.push(request); return request.promise; }
    throw Error("Unexpected polling call " + args.method);
  };
  mount(<OmpSubagentDock sessionId="native-pi:a" />);
  await until(view, "worker loaded"); click(view());
  await until(() => requests.length === 1, "initial transcript read");
  await tick(); await tick();
  check(requests.length === 1, "slow transcript reads must not overlap");
  requests[0].reject(Error("temporary transcript failure"));
  await until(() => document.querySelector(".omp-error"), "transcript failure visible");
  await tick(); await until(() => requests.length === 2, "poll after failed read");
  requests[1].resolve({ messages: [message("recovered transcript")] });
  await until(() => document.querySelector(".omp-transcript")?.textContent.includes("recovered transcript"), "recovered transcript");
  check(!document.querySelector(".omp-error"), "successful refresh clears stale error");
  emit("native.subagents.changed", { sessionId: "native-pi:a", subagents: [{ ...agent, status: "completed" }] });
  await until(() => requests.length === 3, "completion triggers final read");
  requests[2].resolve({ messages: [message("final transcript")] }); await pause();
  await tick(); await tick();
  check(requests.length === 3 && timers.size === 0, "completed worker stops transcript polling");
}

async function sessionSwitch() {
  const calls = [];
  invoke = async (_channel, args) => {
    calls.push(args);
    if (args.method === "omp.subagents.list") return { subagents: [{ ...agent, id: args.params.sessionId }] };
    if (args.method === "omp.subagents.messages") return { messages: [message(args.params.sessionId + " transcript")] };
    return {};
  };
  mount(<OmpSubagentDock sessionId="native-pi:a" />);
  await until(view, "first worker"); click(view());
  await until(() => document.querySelector(".omp-subagent-dialog"), "first transcript");
  mount(<OmpSubagentDock sessionId="native-pi:b" />); await pause(); await pause();
  check(!document.querySelector(".omp-subagent-dialog"), "switching session closes old worker transcript");
  check(!calls.some((args) => args.method === "omp.subagents.messages" && args.params.sessionId === "native-pi:b" && args.params.subagentId === "native-pi:a"), "old worker never queried under new session");
  mount(null); check(timers.size === 0 && listeners.size === 0, "dock cleanup removes timers and subscriptions");
}

async function totalsIdentity() {
  const next = deferred();
  invoke = async (_channel, args) => args.params.sessionId === "native-pi:a" ? { stats: { cost: 123.45 } } : next.promise;
  mount(<OmpSessionTotals sessionId="native-pi:a" refreshKey={0} />);
  await until(() => document.body.textContent.includes("$123.45"), "first session totals");
  mount(<OmpSessionTotals sessionId="native-pi:b" refreshKey={0} />);
  check(!document.body.textContent.includes("$123.45"), "new session never displays old session totals");
  next.resolve({ stats: { cost: 2 } });
  await until(() => document.body.textContent.includes("$2.00"), "new totals resolve");
}

async function branchIdentity() {
  const next = deferred();
  invoke = async (_channel, args) => args.params.sessionId === "native-pi:a"
    ? { nodes: [{ id: "old-node", parentId: null, role: "user", preview: "old session branch", onPath: true, children: [] }], leafId: "old-node" }
    : next.promise;
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:a", messages: [message("hello")] }));
  mount(<OmpBranchTreeButton />); click(document.querySelector(".omp-tree-btn"));
  await until(() => document.querySelector(".omp-tree-node"), "old branch");
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:b" }));
  check(!document.querySelector(".omp-tree-node"), "old branch cannot be forked into new session while loading");
  next.resolve({ nodes: [], leafId: null });
}

async function approvalLoading() {
  const initial = deferred(), save = deferred(), writes = [];
  invoke = async (channel, args) => {
    if (channel === IPC.invoke.ompApprovalGet) return initial.promise;
    if (channel === IPC.invoke.ompApprovalSet) { writes.push(args); return save.promise; }
    throw Error("Unexpected approval call");
  };
  mount(<OmpApprovalSection />);
  fill(document.querySelector("[data-omp-approval-new-tool]"), "edit");
  const add = button(i18n.t("settings.ompApproval.add"));
  click(add);
  check(writes.length === 0 && add.disabled, "cannot replace unknown existing policy rules before load");
  initial.resolve({ mode: "write", rules: { bash: "deny" } });
  await until(() => !add.disabled, "rules loaded"); click(add);
  check(writes.length === 1 && writes[0].rules.bash === "deny" && writes[0].rules.edit === "allow", "rule edit preserves loaded policy");
  save.resolve({ ok: true }); await pause();
}

async function rolesSingleFlight() {
  const save = deferred(), writes = [];
  const roles = [{ id: "default", name: "default", builtin: true, model: "fixture/one" }];
  invoke = async (channel, args) => {
    if (channel === IPC.invoke.ompRolesList) return { roles };
    if (channel === IPC.invoke.ompModelsList) return { models: [{ provider: "fixture", id: "one", name: "One" }, { provider: "fixture", id: "two", name: "Two" }], thinkingLevels: [] };
    if (channel === IPC.invoke.ompRoleSet) { writes.push(args); return save.promise; }
    throw Error("Unexpected roles call " + channel);
  };
  mount(<OmpRolesPage />);
  await until(() => document.querySelector('[data-omp-role-model="default"] option[value="fixture/two"]'), "model roles loaded");
  const select = document.querySelector('[data-omp-role-model="default"]');
  select.value = "fixture/two";
  flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  check(select.disabled, "existing model selectors lock during persistence");
  select.value = "fixture/one";
  flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  check(writes.length === 1, "pending role write cannot be duplicated through change handler");
  save.resolve({ roles: [{ ...roles[0], model: "fixture/two" }] });
  await until(() => !select.disabled && select.value === "fixture/two", "role save readback");
}

async function loginResponse() {
  const started = deferred(), responses = [];
  invoke = async (_channel, args) => {
    if (args.method === "omp.login.providers") return { providers: [{ id: "fixture", name: "Fixture", available: true, authenticated: false }] };
    if (args.method === "omp.login.start") {
      // The sidecar is allowed to emit before the start RPC settles or React commits.
      for (const listener of listeners) listener({ method: "native.login.ui", params: { kind: "input", requestId: "code", title: "Enter fixture code" } });
      return started.promise;
    }
    if (args.method === "omp.login.respond") { const request = deferred(); responses.push({ ...request, args }); return request.promise; }
    if (args.method === "omp.login.cancel") return {};
    throw Error("Unexpected login call " + args.method);
  };
  mount(<OmpAccountsSection />);
  await until(() => button(i18n.t("settings.ompAccounts.signIn")), "provider loaded");
  click(button(i18n.t("settings.ompAccounts.signIn")));
  await until(() => document.querySelector(".omp-login-input"), "immediate login input event retained");
  const input = document.querySelector(".omp-login-input"); fill(input, "fixture-code");
  const form = input.closest("form"); submit(form); submit(form);
  check(responses.length === 1, "login code sends once while pending");
  responses[0].reject(Error("code delivery failed"));
  await until(() => document.querySelector(".omp-error")?.textContent.includes("code delivery failed"), "login response failure visible");
  check(document.querySelector(".omp-login-input")?.value === "fixture-code", "failed code stays editable for retry");
  submit(document.querySelector(".omp-login-input").closest("form"));
  check(responses.length === 2, "failed code can be resubmitted");
  responses[1].resolve({}); await pause();
  check(!document.querySelector(".omp-login-input"), "successful response is acknowledged");
  started.resolve({}); await until(() => !document.querySelector(".omp-login-dialog"), "login completion closes dialog");
}

async function loopLiveUpdate() {
  const loop = { prompt: "keep going", total: 3, done: 2 };
  invoke = async (_channel, args) => {
    if (args.method === "omp.session.command") {
      if (args.params.command.type === "get_loop") return { loop: null };
      throw Error("Unexpected loop command " + args.params.command.type);
    }
    throw Error("Unexpected call " + args.method);
  };
  mount(<OmpLoopDock sessionId="native-pi:a" />);
  check(!document.querySelector('[data-omp-loop]'), "idle loop must stay hidden");
  emit("native.loop", { sessionId: "native-pi:a", loop });
  check(document.querySelector('[data-omp-loop]')?.textContent.includes("2"), "live loop event must reach the dock");
  emit("native.loop", { sessionId: "native-pi:b", loop });
  check(document.querySelector('[data-omp-loop]')?.textContent.includes("2"), "another session's loop must not change this dock");
  emit("native.loop", { sessionId: "native-pi:a", loop: null });
  check(!document.querySelector('[data-omp-loop]'), "loop stop must clear the dock");
}

window.ompUiAsyncProbe = async () => {
  const results = {};
  for (const [name, run] of Object.entries({ eventWinsSnapshot, pollingLifecycle, sessionSwitch, totalsIdentity, branchIdentity, approvalLoading, rolesSingleFlight, loginResponse, loopLiveUpdate })) {
    try { await run(); results[name] = "passed"; }
    catch (error) { results[name] = String(error.message ?? error); }
    finally { mount(null); await pause(); timers.clear(); }
  }
  check(listeners.size === 0, "all OMP subscriptions removed after unmount");
  return results;
};
`;

test("OMP UI asynchronous snapshots, mutations and cleanup retain session ownership", { skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(source, "ompUiAsyncProbe");
  assert.deepEqual(result, Object.fromEntries(Object.keys(result).map((name) => [name, "passed"])));
});
