import assert from "node:assert/strict";
import test from "node:test";
import { runOmpRendererProbe, rendererProbeUnavailable } from "./helpers/omp-renderer-probe.mjs";

const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { OmpSessionActionsButton, OmpLoopDock } from "./apps/desktop/src/features/omp/OmpSessionActions";
import { useAppStore } from "./apps/desktop/src/stores/app-store";
const listeners = new Set();
const commands = [];
const exports = [];
const opened = [];
const revealed = [];
let newWindows = 0;
let btwResolve;
let handoffResolve;
let goal = null;
let exportMode = "cancel";
const loops = new Map();
const original = { id: "history-topic", question: "Remembered question?", answer: "Persisted answer", status: "complete" };
function emit(method, sessionId, frame) {
  for (const listener of listeners) listener({ method, params: { sessionId, frame } });
}
window.piDesktop = { platform: "linux", on(channel, listener) { if (channel === IPC.event.ompEvent) listeners.add(listener); return () => listeners.delete(listener); }, async invoke(channel, input) {
  let data;
  if (channel === IPC.invoke.ompCall) {
    const { sessionId, command } = input.params;
    commands.push({ sessionId, ...command });
    let result;
    if (command.type === "get_loop") result = { loop: loops.get(sessionId) ?? null };
    else if (command.type === "loop_start") {
      const loop = { prompt: command.prompt, total: command.count, done: 1 };
      loops.set(sessionId, loop);
      for (const listener of listeners) listener({ method: "native.loop", params: { sessionId, loop } });
      result = { loop };
    } else if (command.type === "loop_stop") {
      loops.delete(sessionId);
      for (const listener of listeners) listener({ method: "native.loop", params: { sessionId, loop: null } });
      result = { loop: null };
    } else if (command.type === "get_btw_history") result = { records: sessionId === "native-pi:a" ? [original] : [] };
    else if (command.type === "btw") result = await new Promise((resolve) => { btwResolve = resolve; });
    else if (command.type === "btw_cancel") result = { cancelled: true };
    else if (command.type === "goal") {
      if (command.op === "create") goal = { objective: command.objective, tokenBudget: command.token_budget, tokensUsed: 0, status: "active" };
      if (command.op === "pause") goal = { ...goal, status: "paused" };
      if (command.op === "resume") goal = { ...goal, status: "active" };
      if (command.op === "drop") goal = null;
      result = { goal, state: goal ? { enabled: true, goal } : null };
    } else if (command.type === "handoff") result = await new Promise((resolve) => { handoffResolve = resolve; });
    else if (command.type === "set_slow_mode") result = { enabled: command.enabled };
    else throw new Error("Unexpected command: " + command.type);
    data = { result };
  } else if (channel === IPC.invoke.ompExportHtml) {
    exports.push(input);
    if (exportMode === "fail") return { ok: false, error: { code: "INTERNAL", message: "fixture export failed" } };
    data = { path: exportMode === "cancel" ? null : "/tmp/local-conversation.html" };
  }
  else if (channel === IPC.invoke.ompOpenExport) { opened.push(input); data = { ok: true }; }
  else if (channel === IPC.invoke.ompRevealExport) { revealed.push(input); data = { ok: true }; }
  else if (channel === IPC.invoke.newChatWindow) { newWindows++; data = { windowId: 3 }; }
  else throw new Error("Unexpected IPC: " + channel);
  return { ok: true, data };
} };
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false, resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const t = (key) => i18n.t("chat.ompActions." + key);
useAppStore.setState({ activeSessionId: "native-pi:a", sessions: [{ id: "native-pi:a", title: "Action fixture" }, { id: "native-pi:b", title: "Second fixture" }], runningSessions: {}, isRunning: false });
function Harness() { const sessionId = useAppStore((state) => state.activeSessionId); return <><OmpSessionActionsButton/><OmpLoopDock key={sessionId} sessionId={sessionId}/></>; }
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Harness/>));
const frame = () => new Promise(requestAnimationFrame);
async function until(fn, message) { for (let i = 0; i < 120; i++) { const result = fn(); if (result) return result; await frame(); } throw new Error(message); }
const dialog = () => document.querySelector('[role="dialog"]');
function button(label, scope = document) { return [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label); }
async function click(label, scope = document) {
  const target = await until(() => { const node = button(label, scope); return node && !node.disabled ? node : null; }, "Action unavailable: " + label + "; buttons=" + [...scope.querySelectorAll("button")].map((node) => node.textContent.trim()).join(" | "));
  target.click();
}
function value(node, text) { const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, text); node.dispatchEvent(new Event("input", { bubbles: true })); }
async function action(name) {
  document.querySelector('[aria-haspopup="menu"]').click();
  const item = await until(() => document.querySelector('[data-omp-action="' + name + '"]'), "Action menu missing " + name);
  item.click();
  await until(dialog, "Dialog missing " + name);
}
async function close() { dialog().querySelector('[aria-label="' + i18n.t("common.close") + '"]').click(); await until(() => !dialog(), "Dialog did not close"); }
window.ompP2Probe = async () => {
  await action("export");
  if (!dialog().textContent.includes(t("shareHint"))) throw new Error("No local-only sharing disclosure");
  await until(() => dialog().contains(document.activeElement), "Modal did not own focus");
  const focusable = [...dialog().querySelectorAll("button")].filter((node) => !node.disabled);
  focusable[0].focus();
  focusable[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  if (document.activeElement !== focusable.at(-1)) throw new Error("Modal backward focus trap failed");
  focusable.at(-1).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  if (document.activeElement !== focusable[0]) throw new Error("Modal forward focus trap failed");
  await click(t("exportSave"), dialog());
  await until(() => button(t("exportSave"), dialog())?.disabled === false, "Cancelled export remained busy");
  if (button(t("exportOpen"), dialog())) throw new Error("Cancelled export offered a file");
  exportMode = "fail";
  await click(t("exportSave"), dialog());
  await until(() => dialog().querySelector('[role="alert"]')?.textContent.includes("fixture export failed"), "Export failure not displayed");
  await until(() => button(t("exportSave"), dialog())?.disabled === false, "Failed export remained busy");
  exportMode = "save";
  await click(t("exportSave"), dialog());
  await until(() => button(t("exportOpen"), dialog()), "Export completion missing");
  await click(t("exportOpen"), dialog());
  await until(() => opened.length === 1, "Export open did not run");
  await until(() => !button(t("exportReveal"), dialog()).disabled, "Export remained busy");
  await click(t("exportReveal"), dialog());
  await until(() => revealed.length === 1, "Export reveal did not run");
  await until(() => !button(t("exportReveal"), dialog()).disabled, "Reveal remained busy");
  await close();
  await until(() => document.activeElement === document.querySelector('[aria-haspopup="menu"]'), "Action trigger focus not restored");
  await action("goal");
  const objective = await until(() => dialog().querySelector('[aria-label="' + t("goalPlaceholder") + '"]'), "Goal get did not finish");
  value(objective, "Finish the task");
  value(dialog().querySelector('[aria-label="' + t("goalBudget") + '"]'), "1000");
  await frame();
  dialog().querySelector("form").requestSubmit();
  await until(() => dialog().querySelector('[data-omp-goal]'), "Goal creation failed");
  await click(t("goalPause"), dialog());
  await until(() => button(t("goalResume"), dialog()), "Goal pause failed");
  await click(t("goalResume"), dialog());
  await until(() => button(t("goalPause"), dialog()), "Goal resume failed");
  emit("native.goal", "native-pi:a", { type: "goal_updated", goal: { ...goal, tokensUsed: 25, status: "paused" } });
  await until(() => dialog().textContent.includes("25"), "Live goal update missing");
  await click(t("goalDrop"), dialog());
  await until(() => dialog().querySelector("form"), "Goal drop failed");
  await close();
  await action("btw");
  await until(() => dialog().textContent.includes("Persisted answer"), "BTW history did not load");
  value(dialog().querySelector("input"), "Follow up");
  await frame();
  dialog().querySelector("form").requestSubmit();
  await until(() => btwResolve, "BTW did not start");
  const running = { ...original, followUps: [{ question: "Follow up", answer: "", status: "running" }] };
  emit("native.btw", "native-pi:a", { type: "btw_record", record: running });
  emit("native.btw", "native-pi:a", { type: "btw_delta", recordId: original.id, delta: "Side answer" });
  await until(() => dialog().textContent.includes("Side answer"), "BTW stream missing");
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:b" }));
  await until(() => !dialog(), "Session switch retained modal");
  await until(() => commands.some((c) => c.type === "btw_cancel" && c.sessionId === "native-pi:a" && c.recordId === original.id), "BTW owner not cancelled");
  btwResolve({ record: { ...running, followUps: [{ question: "Follow up", answer: "Stale reply", status: "complete" }] } });
  emit("native.btw", "native-pi:a", { type: "btw_delta", recordId: original.id, delta: "stale" });
  await action("btw");
  await until(() => !dialog().querySelector("input").disabled, "New session BTW not ready");
  if (dialog().textContent.includes("Stale reply") || dialog().textContent.includes("Persisted answer")) throw new Error("Cross-session BTW history");
  await close();
  await action("loop");
  value(dialog().querySelector("textarea"), "Repeat in B");
  value(dialog().querySelector("input"), "2.5");
  await frame();
  if (!button(t("loopStart"), dialog()).disabled) throw new Error("Fractional loop count accepted");
  value(dialog().querySelector("input"), "3");
  await frame();
  dialog().querySelector("form").requestSubmit();
  await until(() => !dialog() && document.querySelector('[data-omp-loop]'), "Loop runtime state not shown");
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:a" }));
  await until(() => !document.querySelector('[data-omp-loop]'), "Loop leaked to A");
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:b" }));
  await until(() => document.querySelector('[data-omp-loop]'), "Loop state lost across dock unmount");
  await click(t("loopStop"));
  await until(() => !document.querySelector('[data-omp-loop]'), "Loop stop not reflected");
  await action("handoff");
  flushSync(() => useAppStore.setState({ runningSessions: { "native-pi:b": true }, isRunning: true }));
  if (!button(t("handoffRun"), dialog()).disabled) throw new Error("Busy handoff enabled");
  flushSync(() => useAppStore.setState({ runningSessions: {}, isRunning: false }));
  await click(t("handoffRun"), dialog());
  await until(() => handoffResolve, "Handoff did not start");
  if (!button(i18n.t("common.cancel"), dialog()).disabled) throw new Error("In-flight handoff not protected");
  handoffResolve(null);
  await until(() => dialog().textContent.includes(t("handoffCancelled")), "Cancelled handoff reported success");
  await close();
  document.querySelector('[aria-haspopup="menu"]').click();
  const newWindow = await until(() => document.querySelector('[data-omp-action="new-window"]'), "New window menu missing");
  newWindow.click();
  await until(() => newWindows === 1, "New window IPC missing");
  return { exports, opened, revealed, newWindows, create: commands.find((c) => c.type === "goal" && c.op === "create"), loop: commands.find((c) => c.type === "loop_start"), switchSafe: true, cancellationSafe: true };
};
`;

test("OMP actions export local HTML, manage goals and side answers, and preserve runtime loop ownership across navigation", { timeout: 60_000, skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(source, "ompP2Probe", process.env.OMP_P2_ACTIONS_SCREENSHOT);
  assert.deepEqual(result.exports, Array.from({ length: 3 }, () => ({ sessionId: "native-pi:a", title: "Action fixture" })));
  assert.deepEqual(result.opened, [{ path: "/tmp/local-conversation.html" }]);
  assert.deepEqual(result.revealed, [{ path: "/tmp/local-conversation.html" }]);
  assert.equal(result.newWindows, 1);
  assert.deepEqual(result.create, { sessionId: "native-pi:a", type: "goal", op: "create", objective: "Finish the task", token_budget: 1000 });
  assert.deepEqual(result.loop, { sessionId: "native-pi:b", type: "loop_start", prompt: "Repeat in B", count: 3 });
  assert.equal(result.switchSafe, true);
  assert.equal(result.cancellationSafe, true);
});
