import assert from "node:assert/strict";
import test from "node:test";
import { rendererProbeUnavailable, runOmpRendererProbe } from "./helpers/omp-renderer-probe.mjs";

const source = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { AgentMcpPage } from "./apps/desktop/src/components/settings/AgentMcpPage";
import { useAppStore } from "./apps/desktop/src/stores/app-store";
const server = { id: "local-fixture", label: "Local MCP", transport: "stdio", command: "node", args: [], enabled: false };
let present = true;
let completeRemoval;
let removals = 0;
let failure = false;
window.piDesktop = { platform: "linux", on() { return () => {}; }, async invoke(channel, input) {
  let data;
  if (channel === IPC.invoke.projectList) data = { projects: [] };
  else if (channel === IPC.invoke.mcpList) data = { servers: input?.level === "global" && present ? [server] : [], statuses: [] };
  else if (channel === IPC.invoke.mcpRemove) {
    removals++;
    await new Promise((resolve) => { completeRemoval = resolve; });
    if (failure) return { ok: false, error: { code: "INVALID_ARGUMENT", message: "fixture deletion failed" } };
    present = false;
    data = { ok: true };
  } else throw new Error("Unexpected IPC: " + channel);
  return { ok: true, data };
} };
await i18n.use(initReactI18next).init({ lng: "zh-CN", fallbackLng: "en", keySeparator: false, resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) }, en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
useAppStore.setState({ workspace: null, projects: [], settings: { theme: "light", language: "zh-CN" } });
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<AgentMcpPage />));
const frame = () => new Promise(requestAnimationFrame);
async function until(fn, message) { for (let i = 0; i < 120; i++) { const value = fn(); if (value) return value; await frame(); } throw new Error(message); }
const dialog = () => document.querySelector('[role="dialog"]');
function button(label, scope = document) { return [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label); }
async function openRemove() {
  const trigger = await until(() => document.querySelector('.agent-capability-menu-wrap button'), "server action trigger missing");
  flushSync(() => trigger.click());
  const item = await until(() => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === i18n.t("extensions.mcp.remove")), "remove menu item missing");
  flushSync(() => item.click());
  return until(dialog, "Remove did not reveal a confirmation dialog");
}
window.ompP2Probe = async () => {
  let modal = await openRemove();
  if (!modal.textContent.includes("Local MCP") || !modal.textContent.includes("移除")) throw new Error("Chinese confirmation does not name the server");
  if (removals !== 0) throw new Error("menu selection deleted without confirmation");
  flushSync(() => button(i18n.t("common.cancel"), modal).click());
  await until(() => !dialog(), "Cancel did not close confirmation");
  if (!present || removals) throw new Error("Cancel deleted configuration");
  modal = await openRemove();
  failure = true;
  const confirm = button(i18n.t("extensions.mcp.remove"), modal);
  flushSync(() => { confirm.click(); confirm.click(); });
  if (removals !== 1) throw new Error("double confirmation duplicated deletion");
  if (!confirm.disabled) throw new Error("confirmation remains active during deletion");
  completeRemoval();
  await until(() => !confirm.disabled, "Failed deletion cannot be retried");
  if (!dialog() || !present) throw new Error("failure removed dialog or server");
  failure = false;
  flushSync(() => confirm.click());
  completeRemoval();
  await until(() => !dialog() && !document.querySelector('.agent-capability-row'), "Removed server remains visible");
  return { removals, present, localized: true, canceledSafely: true, failureRecoverable: true };
};
`;

test("MCP Remove opens a localized confirmation, cancels safely and retries failed deletion", { timeout: 60_000, skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(source, "ompP2Probe", process.env.OMP_P2_MCP_SCREENSHOT);
  assert.deepEqual(result, { removals: 2, present: false, localized: true, canceledSafely: true, failureRecoverable: true });
});
