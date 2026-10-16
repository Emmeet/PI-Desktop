import assert from "node:assert/strict";
import test from "node:test";
import { rendererProbeUnavailable, runOmpRendererProbe } from "./helpers/omp-renderer-probe.mjs";

const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en, zhCN } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SettingsPage } from "./apps/desktop/src/features/settings/SettingsPage";
import { ScheduledPage } from "./apps/desktop/src/pages/ScheduledPage";
import { OnboardingChecklist } from "./apps/desktop/src/components/OnboardingChecklist";
import { ContextUsageInspector } from "./apps/desktop/src/components/ContextUsageInspector";
import { useArmedDelete, ARMED_DELETE_MS } from "./apps/desktop/src/hooks/use-armed-delete";
import { useAppStore } from "./apps/desktop/src/stores/app-store";

const root = createRoot(document.getElementById("root"));
const nativeTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const pause = () => new Promise((resolve) => nativeTimeout(resolve, 0));
const check = (condition, message) => { if (!condition) throw Error(message); };
async function until(predicate, description) {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { if (predicate()) return; await pause(); }
  throw Error("Timeout: " + description);
}
const mount = (node) => flushSync(() => root.render(node));
const state = (patch) => flushSync(() => useAppStore.setState(patch));
const textButton = (text, container = document) => [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
async function click(node, point = "center") {
  check(node, "click target exists");
  node.scrollIntoView({ block: "nearest", behavior: "instant" });
  await new Promise(requestAnimationFrame);
  const box = node.getBoundingClientRect();
  const x = Math.round(box.left + box.width / 2);
  const y = Math.round(point === "top" ? box.top + 2 : point === "bottom" ? box.bottom - 2 : box.top + box.height / 2);
  check(document.elementFromPoint(x, y)?.closest("button, input, textarea") === node.closest("button, input, textarea"), "painted control owns its coordinate");
  await window.rendererProbeInput([
    { type: "mouseMove", x, y },
    { type: "mouseDown", x, y, button: "left", clickCount: 1 },
    { type: "mouseUp", x, y, button: "left", clickCount: 1 },
  ]);
  await pause();
}
function fill(node, value) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
  flushSync(() => node.dispatchEvent(new Event("input", { bubbles: true })));
}
let models = [];
let modelFailure = false;
let modelReads = 0;
let dismissals = 0;
const tasks = [];
const saved = [];
const listeners = new Set();
window.piDesktop = {
  platform: "linux",
  on(_channel, listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async invoke(channel, args) {
    let data;
    if (channel === IPC.invoke.ompModelsList) {
      ++modelReads;
      if (modelFailure) return { ok: false, error: { code: "OMP_NOT_FOUND", message: "Fixture omp unavailable" } };
      data = { models, defaultModel: null, selected: null, thinkingLevel: "off", thinkingLevels: [] };
    } else if (channel === IPC.invoke.ompRolesList) data = { roles: [] };
    else if (channel === IPC.invoke.appDismissOnboarding) { ++dismissals; data = {}; }
    else if (channel === IPC.invoke.pluginScenicThemesDestinations) data = [];
    else if (channel === IPC.invoke.ompConfigGet) data = { values: {} };
    else if (channel === IPC.invoke.ompThemes) data = { names: [], palettes: {} };
    else if (channel === IPC.invoke.ompCall && args.method === "omp.login.providers") data = { providers: [] };
    else if (channel === IPC.invoke.projectList) data = { projects: [{ id: "project", name: "Fixture", path: "/tmp/fixture" }] };
    else if (channel === IPC.invoke.scheduledList) data = { tasks: [...tasks] };
    else if (channel === IPC.invoke.scheduledListRuns) data = { runs: [] };
    else if (channel === IPC.invoke.scheduledCreate) {
      saved.push(args);
      const task = { ...args, id: "task-" + saved.length, mode: "agent", enabled: true, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" };
      tasks.push(task); data = { task };
    } else throw Error("Unexpected fixture IPC: " + channel);
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en }, "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
state({ page: "settings", settingsTab: "accounts", settings: { onboardingDismissed: false, developerMode: false }, providers: [], activeSessionId: undefined, sessions: [], messages: [], workspace: undefined });

async function settingsCoordinates() {
  let hits = 0;
  for (const platform of ["linux", "win32", "darwin"]) {
    document.documentElement.dataset.platform = platform;
    mount(<div className="app-shell settings-mode" style={{ height: 420 }}><SettingsPage /></div>);
    await until(() => document.querySelector(".settings-nav-label"), "settings rail");
    const rail = document.querySelector(".settings-nav-scroll");
    check(rail.scrollHeight > rail.clientHeight, "short-window rail actually scrolls");
    for (const [id, key] of [["ompPrefs", "settings.nav.ompPrefs"], ["accounts", "settings.nav.accounts"]]) {
      const labelText = i18n.t(key);
      const label = [...document.querySelectorAll(".settings-nav-label")].find((node) => node.textContent === labelText);
      check(label, "localized settings label " + key);
      await click(label);
      await until(() => useAppStore.getState().settingsTab === id, "native label-coordinate selects " + id);
      ++hits;
      const button = label.closest("button");
      state({ settingsTab: id === "accounts" ? "ompPrefs" : "accounts" });
      await click(button, "top");
      await until(() => useAppStore.getState().settingsTab === id, "top of painted row selects " + id);
      ++hits;
      state({ settingsTab: id === "accounts" ? "ompPrefs" : "accounts" });
      await click(button, "bottom");
      await until(() => useAppStore.getState().settingsTab === id, "bottom of painted row selects " + id);
      ++hits;
    }
    const search = document.querySelector(".settings-search");
    await click(search);
    await window.rendererProbeInput([{ type: "text", text: i18n.t("settings.nav.ompPrefs") }]);
    await until(() => document.querySelectorAll(".settings-nav-item").length === 1, "filtered rail");
    const label = document.querySelector(".settings-nav-label");
    await click(label);
    await until(() => useAppStore.getState().settingsTab === "ompPrefs", "filtered native-coordinate hit");
    ++hits;
    mount(null);
  }
  document.documentElement.dataset.platform = "linux";
  return hits;
}

async function scheduledForm() {
  state({ page: "scheduled", workspace: { path: "/tmp/fixture" } });
  mount(<div className="app-shell"><ScheduledPage /></div>);
  await until(() => textButton(i18n.t("scheduled.create")), "create task action");
  await click(textButton(i18n.t("scheduled.create")));
  await until(() => document.querySelector(".dest-create input[maxlength='80']"), "create dialog mounts");
  const title = document.querySelector(".dest-create input[maxlength='80']");
  const prompt = document.querySelector(".dest-create textarea");
  const form = title.closest("form");
  await until(() => document.activeElement === title, "new task initial focus belongs to the name");
  check(document.activeElement === title, "new task initial focus belongs to the name");
  await window.rendererProbeInput([{ type: "text", text: "Keyboard name" }]);
  await until(() => title.value === "Keyboard name", "initial keyboard text goes to name");
  check(prompt.value === "", "initial typing does not enter instructions");
  const save = textButton(i18n.t("scheduled.save"), form);
  check(save.disabled, "missing prompt disables persistence");
  fill(title, ""); fill(prompt, "Run the fixture");
  check(save.disabled && title.getAttribute("aria-invalid") === "true", "blank name disables save and marks the field");
  let hint = document.getElementById(title.getAttribute("aria-describedby"));
  check(hint?.textContent === i18n.t("scheduled.nameRequired"), "blank name has an explicit localized hint");
  for (const value of ["", "   "]) {
    fill(title, value);
    flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    check(saved.length === 0, "invalid title cannot bypass disabled save through form submit");
  }
  await i18n.changeLanguage("zh-CN"); await pause();
  hint = document.getElementById(title.getAttribute("aria-describedby"));
  check(hint?.textContent === i18n.t("scheduled.nameRequired") && !hint.textContent.includes("scheduled."), "Chinese validation is localized");
  await i18n.changeLanguage("en"); await pause();
  fill(title, "  Daily fixture  "); fill(prompt, "   ");
  flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  check(saved.length === 0, "blank instructions are not persisted either");
  fill(prompt, "  Run the fixture  ");
  check(!save.disabled && !title.hasAttribute("aria-invalid") && !title.hasAttribute("aria-describedby"), "valid title clears the hint");
  await click(save);
  await until(() => saved.length === 1 && !document.querySelector(".dest-create"), "valid task saved through production workspace");
  check(saved[0].title === "Daily fixture" && saved[0].prompt === "Run the fixture", "persistence receives trimmed valid fields");
  mount(null);
  return { saved: saved.length, initialFocus: true, invalidBlocked: true, localized: true };
}

function onboardingState(project = true, plugin = true) {
  return { showChecklist: true, steps: [
    { id: "provider", title: "host provider", done: false },
    { id: "secret", title: "host key", done: false },
    { id: "prompt", title: "host prompt", done: false },
    { id: "project", title: "Project", done: project, action: "project.open" },
    { id: "plugin", title: "Plugin", done: plugin, action: "plugins.open" },
  ] };
}
async function onboardingFlow() {
  models = []; modelFailure = false;
  state({ page: "chat", settings: { onboardingDismissed: false }, providers: [], onboarding: { ...onboardingState(), showChecklist: false } });
  mount(<OnboardingChecklist />);
  await until(() => textButton(i18n.t("onboarding.ompSetup")), "missing omp models show setup despite existing projects/plugins");
  check(useAppStore.getState().onboarding.showChecklist === false, "missing omp setup does not depend on host provider completion");
  check(document.querySelector("[role='status']")?.textContent === i18n.t("onboarding.ompSetupHint"), "setup explains omp config ownership");
  await click(textButton(i18n.t("onboarding.ompSetup")));
  await until(() => useAppStore.getState().page === "settings" && useAppStore.getState().settingsTab === "accounts", "setup links to Accounts & subscriptions");
  check(useAppStore.getState().page === "settings" && useAppStore.getState().settingsTab === "accounts", "setup links to Accounts & subscriptions");
  models = [{ provider: "stepfun", id: "step-5-preview", name: "Step 5 Preview", contextWindow: 262144, reasoning: true }];
  const before = modelReads;
  state({ page: "chat", onboarding: onboardingState() });
  await until(() => modelReads > before && !document.querySelector("[data-testid='onboarding-checklist']"), "omp availability replaces empty host-provider signal");
  state({ onboarding: onboardingState(false, false) });
  await until(() => document.querySelector("[data-testid='onboarding-checklist']"), "optional steps remain when omp models are ready");
  check(!textButton(i18n.t("onboarding.ompSetup")), "configured omp does not claim missing provider");
  models = [];
  state({ page: "chat", onboarding: onboardingState() });
  window.dispatchEvent(new Event("focus"));
  await until(() => textButton(i18n.t("onboarding.ompSetup")), "setup returns when omp no longer has a usable model");
  models = [{ provider: "stepfun", id: "step-5-preview", name: "Step 5 Preview", reasoning: true }];
  window.dispatchEvent(new Event("focus"));
  await until(() => !document.querySelector("[data-testid='onboarding-checklist']"), "window focus refreshes external omp setup");
  state({ page: "plugins" });
  modelFailure = true;
  state({ page: "chat", onboarding: onboardingState() });
  await until(() => document.querySelector("[role='status']")?.textContent === i18n.t("onboarding.ompUnavailable"), "catalog failure is reported distinctly from missing configuration");
  await i18n.changeLanguage("zh-CN"); await pause();
  check(textButton(i18n.t("onboarding.ompSetup")) && !document.body.textContent.includes("onboarding."), "Chinese setup guidance is localized");
  await click(textButton(i18n.t("onboarding.dismiss")));
  await until(() => dismissals === 1 && !document.querySelector("[data-testid='onboarding-checklist']"), "dismissal persists and hides guidance");
  check(useAppStore.getState().settings.onboardingDismissed, "dismissal updates renderer persisted settings snapshot");
  mount(null);
  state({ onboarding: onboardingState() });
  const dismissedReads = modelReads;
  mount(<OnboardingChecklist />); await pause();
  check(!document.querySelector("[data-testid='onboarding-checklist']") && modelReads === dismissedReads, "remount respects dismissal without querying models");
  mount(null); await i18n.changeLanguage("en");
  return { availableUsesOmp: true, missingGuides: true, errorDistinct: true, dismissalRespected: true };
}

async function deleteWindow() {
  check(ARMED_DELETE_MS === 5000, "shared confirmation window is five seconds");
  let now = 0, nextId = 1000000, deletions = 0;
  const timers = new Map();
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== ARMED_DELETE_MS && delay !== 1000) return nativeTimeout(callback, delay, ...args);
    const id = ++nextId; timers.set(id, { due: now + delay, callback: () => callback(...args) }); return id;
  };
  window.clearTimeout = (id) => { if (!timers.delete(id)) nativeClearTimeout(id); };
  const tick = async (ms) => {
    now += ms;
    flushSync(() => { for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.callback(); } });
    await pause();
  };
  const arm = async (node, timeout = ARMED_DELETE_MS) => {
    await click(node);
    await until(() => [...timers.values()].some((timer) => timer.due === now + timeout), "armed delete timer registered before advancing clock");
  };
  function DeleteProbe({ timeout }) {
    const { armed, setArmed } = useArmedDelete(timeout);
    return <div>{["a", "b"].map((id) => <button key={id} data-delete={id} data-armed={armed === id} onClick={() => {
      if (armed === id) { ++deletions; setArmed(null); } else setArmed(id);
    }}>{armed === id ? "Confirm " : "Delete "}{id}</button>)}<button data-cancel onClick={() => setArmed(null)}>Cancel</button></div>;
  }
  try {
    mount(<DeleteProbe />);
    const a = document.querySelector("[data-delete='a']"), b = document.querySelector("[data-delete='b']");
    await arm(a); check(deletions === 0, "first click only arms");
    await tick(4999); check(a.dataset.armed === "true", "still armed immediately before five seconds");
    await click(a); await until(() => deletions === 1, "second click before deadline confirms");
    check(deletions === 1, "second click before deadline confirms");
    await arm(a); await tick(2500); await arm(b); await tick(2500);
    check(b.dataset.armed === "true" && a.dataset.armed === "false", "switching rows cancels old deadline");
    await tick(2499); check(b.dataset.armed === "true", "new row gets a full five seconds");
    await tick(1); check(b.dataset.armed === "false", "disarms at the five-second boundary");
    await arm(b); check(deletions === 1 && b.dataset.armed === "true", "late click re-arms rather than deleting");
    await click(document.querySelector("[data-cancel]"));
    await until(() => b.dataset.armed === "false", "explicit cancel clears the armed row");
    check(timers.size === 0, "explicit cancel clears deadline");
    mount(<DeleteProbe timeout={1000} />); await arm(a, 1000); await tick(999);
    check(a.dataset.armed === "true", "custom timeout remains supported");
    await tick(1); check(a.dataset.armed === "false", "custom timeout boundary");
    await arm(a, 1000); mount(null);
    await until(() => timers.size === 0, "unmount clears armed deadline");
    check(timers.size === 0, "unmount clears armed deadline");
  } finally { window.setTimeout = nativeTimeout; window.clearTimeout = nativeClearTimeout; }
  return { confirmed: deletions, beforeBoundary: true, expires: true, rowSwitch: true, cleanup: true };
}

async function contextRing() {
  state({ activeSessionId: undefined, sessions: [], messages: [], settings: {} });
  const show = (inputTokens) => {
    const usage = { inputTokens, outputTokens: 0, totalTokens: inputTokens };
    mount(<div className="app-shell"><section className="main-pane"><div style={{ margin: 100 }}><ContextUsageInspector usage={usage} turnUsage={usage} contextWindow={100} tools={[]} /></div></section></div>);
  };
  show(3);
  let trigger = document.querySelector(".context-inspector-trigger");
  check(trigger.textContent === "3%" && trigger.getAttribute("aria-label").includes(i18n.t("chat.usageContextAriaUsed")), "default trigger reports used not remaining");
  const firstOffset = Number(document.querySelector(".context-inspector-ring-progress").getAttribute("stroke-dashoffset"));
  trigger.focus();
  await until(() => document.querySelector("[role='tooltip']"), "context tooltip");
  check(document.querySelector("[role='tooltip']").textContent === trigger.getAttribute("aria-label"), "hover/focus explanation matches the leading figure");
  await click(trigger);
  await until(() => document.querySelector(".context-inspector-heading-percent"), "context detail panel");
  check(document.querySelector(".context-inspector-heading-percent").textContent === "3%", "detail heading matches used trigger");
  show(25);
  check(document.querySelector(".context-inspector-ring-value").textContent === "25%", "ring increases with consumption");
  const grownOffset = Number(document.querySelector(".context-inspector-ring-progress").getAttribute("stroke-dashoffset"));
  check(grownOffset < firstOffset, "used arc grows rather than counting down");
  state({ settings: { contextUsageDisplay: "remaining" } });
  trigger = document.querySelector(".context-inspector-trigger");
  check(trigger.textContent === "75%" && trigger.getAttribute("aria-label").includes(i18n.t("chat.usageContextAriaRemaining")), "explicit remaining preference is preserved");
  check(document.querySelector(".context-inspector-heading-percent").textContent === "75%", "open detail follows preference changes");
  check(document.querySelector(".context-inspector-heading-value").textContent === i18n.t("chat.usageContextLeft", { count: "75" }), "remaining token heading is coherent");
  state({ settings: { contextUsageDisplay: "used" } }); show(95);
  check(document.querySelector(".context-inspector").dataset.level === "critical", "critical capacity color does not flip with used display");
  state({ settings: { contextUsageDisplay: "remaining" } });
  check(document.querySelector(".context-inspector").dataset.level === "critical", "remaining and used share warning semantics");
  show(150);
  check(document.querySelector(".context-inspector-ring-value").textContent === "0%", "remaining capacity clamps at zero");
  state({ settings: {} });
  check(document.querySelector(".context-inspector-ring-value").textContent === "100%", "used capacity clamps at one hundred");
  mount(null);
  return { increasingUsed: true, explicitRemaining: true, tooltipCoherent: true, boundaries: true };
}
window.ompUiInteractionsProbe = async () => ({
  settingsNativeHits: await settingsCoordinates(),
  scheduled: await scheduledForm(),
  onboarding: await onboardingFlow(),
  deletion: await deleteWindow(),
  context: await contextRing(),
});
`;

test("production renderer preserves native settings hit targets, valid scheduled drafts, omp onboarding, delete deadlines and coherent context usage", { timeout: 90_000, skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(source, "ompUiInteractionsProbe", process.env.OMP_UI_INTERACTIONS_SCREENSHOT, { nativeInput: true });
  assert.equal(result.settingsNativeHits, 21);
  assert.deepEqual(result.scheduled, { saved: 1, initialFocus: true, invalidBlocked: true, localized: true });
  assert.deepEqual(result.onboarding, { availableUsesOmp: true, missingGuides: true, errorDistinct: true, dismissalRespected: true });
  assert.deepEqual(result.deletion, { confirmed: 1, beforeBoundary: true, expires: true, rowSwitch: true, cleanup: true });
  assert.deepEqual(result.context, { increasingUsed: true, explicitRemaining: true, tooltipCoherent: true, boundaries: true });
});
