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
import { OmpCompatibilityNotice } from "./apps/desktop/src/features/omp/OmpCompatibilityNotice";
import { ComposerStatus } from "./apps/desktop/src/features/chat/composer/ComposerStatus";
import { useAppStore } from "./apps/desktop/src/stores/app-store";
window.ompStartupRecoveryProbe = async () => {
const root = createRoot(document.getElementById("root"));
const check = (value, message) => { if (!value) throw Error(message); };
const mount = (node) => flushSync(() => root.render(node));
const until = async (predicate, description) => {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { if (predicate()) return; await new Promise(requestAnimationFrame); }
  throw Error("Timeout: " + description);
};
let code = "OMP_NOT_FOUND";
let checks = 0;
let deferred;
let entries = [];
const calls = [];
window.piDesktop = { platform:"linux", on:() => () => {}, async invoke(channel, input) {
  calls.push({channel,input});
  if (channel === IPC.invoke.ompCall && input.method === "omp.capability.check") {
    checks++;
    if (deferred) return deferred;
    return code ? {ok:false,error:{code,message:"Unlocalized engine failure"}} : {ok:true,data:{version:"18.10.1",protocolVersion:1}};
  }
  if (channel === IPC.invoke.agentQueueRemove) {
    entries = entries.filter(entry => entry.id !== input.turnId);
    return {ok:true,data:{ok:true}};
  }
  if (channel === IPC.invoke.agentQueueList) return {ok:true,data:{entries}};
  throw Error("Unexpected external IPC " + channel);
}};
await i18n.use(initReactI18next).init({lng:"zh-CN",fallbackLng:"en",resources:{en:{translation:en},"zh-CN":{translation:zhCN}},interpolation:{escapeValue:false}});
const noSetup = {ready:true,activeSessionId:undefined,settings:{onboardingDismissed:true},onboarding:{showChecklist:false,steps:[]}};
useAppStore.setState(noSetup);
const alert = () => document.querySelector('[data-testid="omp-compatibility-notice"]');
const button = key => [...document.querySelectorAll("button")].find(node => node.textContent.trim() === i18n.t(key));
mount(<OmpCompatibilityNotice />);
await until(alert,"startup checks even with dismissed onboarding and no conversation");
check(/[\u4e00-\u9fff]/.test(alert().textContent) && alert().textContent.includes("bun install"),"missing omp has Chinese actionable install instructions");
check(!alert().textContent.includes("Unlocalized engine failure"),"engine output is not exposed instead of localized guidance");
code = "OMP_VERSION_UNSUPPORTED";
flushSync(() => button("errors.action.retry").click());
await until(() => !button("errors.action.retry").disabled && alert().textContent.includes("18.10"),"retry reports supported version range");
check(checks === 2,"retry performs a fresh capability check");
code = null;
flushSync(() => button("errors.action.retry").click());
await until(() => !alert(),"install/upgrade recovery clears persistent alert");
mount(null);
code = "OMP_VERSION_PROBE_FAILED";
mount(<OmpCompatibilityNotice />);
await until(alert,"next startup probes again");
flushSync(() => document.querySelector('[aria-label="' + i18n.t("errors.action.dismiss") + '"]').click());
check(!alert(),"dismiss permits configuration access without a blocking dialog");
mount(null);
let release;
deferred = new Promise(resolve => { release = resolve; });
const before = checks;
mount(<OmpCompatibilityNotice />);
await until(() => checks > before,"pending capability request started");
mount(<div data-testid="replacement">Unrelated view</div>);
release({ok:false,error:{code:"OMP_NOT_FOUND",message:"late"}});
await new Promise(requestAnimationFrame);
check(!alert() && document.querySelector('[data-testid="replacement"]'),"stale completion does not restore an unmounted alert");
deferred = null;

const sessionId = "native-pi:queue-review";
entries = [
  {id:"ompq:uncertain",sessionId,content:"Retain this exact interrupted insertion",createdAt:"2026-10-16T00:00:00Z",deliveryStatus:"uncertain"},
  {id:"ompq:waiting",sessionId,content:"Next queued message",createdAt:"2026-10-16T00:00:01Z"},
];
useAppStore.setState({activeSessionId:sessionId,queuedPrompts:{},composerPrefill:undefined});
flushSync(() => useAppStore.getState().applyQueueChanged({sessionId,entries}));
function Queue() {
  const queue = useAppStore(state => state.queuedPrompts[sessionId] || []);
  const state = useAppStore.getState();
  return <ComposerStatus t={i18n.t.bind(i18n)} queuedPrompts={queue} removeQueuedPrompt={state.removeQueuedPrompt} moveQueuedPrompt={state.moveQueuedPrompt}
    editQueuedPrompt={state.editQueuedPrompt} sendQueuedNow={state.sendQueuedNow} approvalPending={false} droppedDirectories={[]}
    openDroppedFolderAsProject={async()=>{}} insertDroppedDirectoryPaths={()=>{}} dismissDroppedDirectories={()=>{}} />;
}
mount(<Queue />);
const row = document.querySelector('[data-testid="queued-prompt"]');
check(row.textContent.includes(entries[0].content),"ambiguous insertion retains original user text");
check(/[\u4e00-\u9fff]/.test(row.querySelector('[role="status"]').textContent),"ambiguous insertion has a Chinese review warning");
check(row.querySelector('.composer-queued-prompt-send-now').disabled && row.querySelector('.composer-queued-prompt-edit').disabled,"ambiguous send/edit cannot automatically replay work");
check(!row.querySelector('.composer-queued-prompt-remove').disabled,"explicit remove remains available");
const priorCalls = calls.length;
await useAppStore.getState().sendQueuedNow(entries[0].id);
await useAppStore.getState().moveQueuedPrompt(entries[0].id,"up");
useAppStore.getState().editQueuedPrompt(entries[0].id);
check(calls.length === priorCalls && !useAppStore.getState().composerPrefill,"store actions also fence ambiguous delivery");
flushSync(() => row.querySelector('.composer-queued-prompt-remove').click());
await until(() => document.querySelectorAll('[data-testid="queued-prompt"]').length === 1,"explicit remove updates authoritative queue");
check(document.querySelector('[data-testid="queued-prompt"]').textContent.includes("Next queued message"),"remove preserves other queued work");
return {startupChinese:true,installHint:true,retry:true,staleCompletion:true,uncertainTextRetained:true,automaticReplayBlocked:true,removeRetainsNext:true};
};
`;

test("startup compatibility alerts and uncertain insertion review survive the real renderer path", { skip: rendererProbeUnavailable, timeout: 60_000 }, async () => {
  const result = await runOmpRendererProbe(source, "ompStartupRecoveryProbe");
  assert.deepEqual(result, { startupChinese: true, installHint: true, retry: true, staleCompletion: true,
    uncertainTextRetained: true, automaticReplayBlocked: true, removeRetainsNext: true });
});
