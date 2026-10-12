import assert from "node:assert/strict";
import test from "node:test";
import { rendererProbeUnavailable, runOmpRendererProbe } from "./helpers/omp-renderer-probe.mjs";

const source = String.raw`
import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, serializeInlineComposerFileReferences } from "@pi-desktop/shared";
import { useComposerCompletions } from "./apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerAutocomplete } from "./apps/desktop/src/components/ComposerAutocomplete";
import { paintEditorValue } from "./apps/desktop/src/features/chat/composer/editor";
import { useAppStore } from "./apps/desktop/src/stores/app-store";
const requests = new Map();
window.piDesktop = { platform: "linux", on() { return () => {}; }, async invoke(channel, input) {
  if (channel !== IPC.invoke.fsIndex) throw new Error("Unexpected IPC: " + channel);
  return new Promise((resolve) => requests.set(input.sessionId, (entries) => resolve({ ok: true, data: { entries, truncated: false } })));
} };
await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false, resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } }, interpolation: { escapeValue: false } });
useAppStore.setState({ activeSessionId: "native-pi:first", workspace: { path: "/fixture/first", name: "First" } });
let controller;
let typeDraft;
let setComposing;
let snapshot;
function Harness() {
  const [draft, setDraft] = useState({ value: "", cursor: 0 });
  const [composing, compose] = useState(false);
  const refs = useRef([]);
  const anchor = useRef(null);
  const session = useAppStore((s) => s.activeSessionId);
  const apply = (value, references, cursor) => { refs.current = references; setDraft({ value, cursor }); };
  const completions = useComposerCompletions({ ...draft, composing, enabled: true, referenceSessionId: session, fileReferencesRef: refs, applyEditorDraft: apply, handleInput(value, cursor) { setDraft({ value, cursor }); return value; }, invalidateComposerTransforms() {} });
  controller = completions;
  typeDraft = (value) => completions.handleInput(value, value.length);
  setComposing = compose;
  snapshot = () => ({ content: serializeInlineComposerFileReferences(draft.value, refs.current), references: refs.current });
  useLayoutEffect(() => { paintEditorValue(anchor.current, draft.value, new Map(refs.current.map((r) => [r.token, r])), () => "移除", () => {}, () => {}, () => {}, () => {}); }, [draft]);
  return <div className="composer" style={{ position: "fixed", left: 100, bottom: 100, width: 800 }}><div ref={anchor} contentEditable className="composer-input" /><ComposerAutocomplete anchorRef={anchor} ac={completions.ac} onAccept={completions.acceptCompletion} /></div>;
}
flushSync(() => createRoot(document.getElementById("root")).render(<Harness />));
const frame = () => new Promise(requestAnimationFrame);
async function until(fn, message) { for (let i = 0; i < 120; i++) { const result = fn(); if (result) return result; await frame(); } throw new Error(message); }
window.ompP2Probe = async () => {
  flushSync(() => typeDraft("Inspect @"));
  await until(() => requests.has("native-pi:first"), "first session index not requested");
  requests.get("native-pi:first")([{ path: "old.ts", kind: "file" }]);
  await until(() => controller.ac.items.some((i) => i.entry?.path === "old.ts"), "first index missing");
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:second", workspace: { path: "/fixture/second", name: "Second" } }));
  if (controller.ac.items.some((i) => i.entry?.path === "old.ts")) throw new Error("old workspace index leaked into new session");
  await until(() => requests.has("native-pi:second"), "second session index not requested");
  flushSync(() => useAppStore.setState({ activeSessionId: "native-pi:third", workspace: { path: "/fixture/third", name: "Third" } }));
  await until(() => requests.has("native-pi:third"), "third session index not requested");
  requests.get("native-pi:second")([{ path: "stale.ts", kind: "file" }]);
  requests.get("native-pi:third")([{ path: "src/new file.ts", kind: "file" }, { path: "src", kind: "dir" }]);
  await until(() => controller.ac.items.some((i) => i.entry?.path === "src/new file.ts"), "current index missing");
  if (controller.ac.items.some((i) => i.entry?.path === "stale.ts")) throw new Error("late old-session index replaced current results");
  flushSync(() => typeDraft('Inspect @"src/new'));
  await until(() => document.querySelector('[role="option"]'), "file choice not visible");
  const choice = [...document.querySelectorAll('[role="option"]')].find((node) => node.title === "src/new file.ts");
  if (!choice || !choice.textContent.includes("new file.ts")) throw new Error("spaced file not selectable");
  flushSync(() => choice.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  const chip = await until(() => document.querySelector(".composer-chip"), "accepted file did not become an inline chip");
  const result = snapshot();
  if (result.references[0].sessionId !== "native-pi:third") throw new Error("file reference belongs to old session");
  if (chip.contentEditable !== "false" || chip.title !== "src/new file.ts") throw new Error("file chip is not atomic or lost its path");
  flushSync(() => typeDraft("@"));
  await until(() => controller.ac.items.length > 0, "file list not reopened");
  const before = controller.ac.items.map((i) => i.entry.path).join(",");
  flushSync(() => { setComposing(true); typeDraft("@nonexistent"); });
  if (controller.ac.items.map((i) => i.entry.path).join(",") !== before) throw new Error("IME composition re-filtered picker");
  flushSync(() => setComposing(false));
  await until(() => controller.ac.items.length === 0, "composition-end did not filter current query");
  return { content: result.content, path: result.references[0].path, staleIsolated: true, imeSafe: true };
};
`;

test("OMP file mentions preserve exact spaced paths and isolate async workspace changes", { timeout: 60_000, skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(source, "ompP2Probe", process.env.OMP_P2_MENTION_SCREENSHOT);
  assert.deepEqual(result, { content: 'Inspect @"src/new file.ts"', path: "src/new file.ts", staleIsolated: true, imeSafe: true });
});
