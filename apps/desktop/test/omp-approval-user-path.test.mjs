import assert from "node:assert/strict";
import test from "node:test";
import { runOmpRendererProbe, rendererProbeUnavailable } from "./helpers/omp-renderer-probe.mjs";

test("desktop approval Settings and real permission cards approve, reject and cancel", { skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from '@pi-desktop/i18n';
import { IPC, normalizeOmpApprovalMode } from '@pi-desktop/shared';
import { OmpApprovalSection } from './apps/desktop/src/features/settings/OmpApprovalSection';
import { PermissionCard } from './apps/desktop/src/components/PermissionCard';
import { useAppStore } from './apps/desktop/src/stores/app-store';
import { headPermission } from './apps/desktop/src/lib/pending-permissions';
import { api } from './apps/desktop/src/lib/api';

const sessionId='native-pi:approval-fixture';
const session={id:sessionId,title:'Approval fixture',source:'pi-native',projectPath:'/isolated/project',mode:'agent',permissionMode:'inherit',thinkingLevel:'off',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[]};
const settings={defaultMode:'agent',theme:'light',enterToSend:true};
const globalConfig={approvalMode:'yolo'};
const writes=[], runs=[], decisions=[], aborted=[];
let scriptedRun, active, finishDecision;
let sequence=0;
function check(condition,message) { if(!condition) throw Error(message); }
function emit(event) { useAppStore.getState().handleAgentEvent({sessionId,turnId:'turn-'+sequence,ts:Date.now(),event}); }
function finish() { active=undefined; emit({type:'agent_end',messageIds:[]}); }
window.piDesktop={
  platform:'linux',on() { return () => {}; },
  async invoke(channel,args) {
    if(channel===IPC.invoke.ompApprovalGet) return {ok:true,data:{mode:normalizeOmpApprovalMode(settings.ompApprovalMode),rules:{}}};
    if(channel===IPC.invoke.ompApprovalSet) {
      writes.push(structuredClone(args)); settings.ompApprovalMode=args.mode;
      return {ok:true,data:{ok:true}};
    }
    if(channel===IPC.invoke.agentPrompt) {
      const script=scriptedRun; scriptedRun=undefined;
      check(script && script.mode===normalizeOmpApprovalMode(settings.ompApprovalMode),'Settings policy reaches external RPC boundary');
      check(args.content===script.tool,'expected fixture tool');
      runs.push({...script}); ++sequence; emit({type:'agent_start'});
      if(script.pending) {
        active={sessionId,requestId:'request-'+sequence,toolCallId:'tool-'+sequence,toolName:script.tool,argsPreview:{path:'/isolated/project/example.txt'},risk:'medium',reason:'Review fixture action'};
        emit({type:'tool_permission_request',request:active});
      } else finish();
      return {ok:true,data:{accepted:true,turnId:'turn-'+sequence}};
    }
    if(channel===IPC.invoke.toolResolvePermission) {
      check(active && args.sessionId===active.sessionId && args.requestId===active.requestId,'answer correlated to actual pending card');
      decisions.push({...args});
      return new Promise(resolve => { finishDecision=() => { finish(); resolve({ok:true,data:{ok:true}}); }; });
    }
    if(channel===IPC.invoke.agentAbort) { aborted.push({...args}); finish(); return {ok:true,data:{ok:true}}; }
    if(channel===IPC.invoke.sessionGet) return {ok:true,data:{session:{...session,messages:[]}}};
    if(channel===IPC.invoke.sessionList) return {ok:true,data:{sessions:[session]}};
    if(channel===IPC.invoke.agentQueueList) return {ok:true,data:{entries:[]}};
    if(channel===IPC.invoke.notificationShowNative) return {ok:true,data:{shown:true}};
    throw Error('Unexpected approval fixture IPC '+channel);
  },
};
await i18n.use(initReactI18next).init({lng:'en',fallbackLng:'en',resources:{en:{translation:en}},interpolation:{escapeValue:false}});
useAppStore.setState({settings:{...settings},activeSessionId:sessionId,sessions:[session],pendingPermissions:{},messages:[],page:'chat'});
function Pending() {
  const permission=useAppStore(state=>headPermission(state.pendingPermissions,sessionId));
  return permission ? <PermissionCard key={permission.requestId} permission={permission}/> : null;
}
let reopen;
function Probe() {
  const [generation,setGeneration]=useState(0);
  reopen=()=>setGeneration(value=>value+1);
  return <><OmpApprovalSection key={generation}/><Pending/><textarea className='composer-input'/></>;
}
createRoot(document.getElementById('root')).render(<Probe/>);
async function pause() { await new Promise(resolve=>setTimeout(resolve,0)); }
async function until(predicate,label) {
  const deadline=performance.now()+5000;
  while(performance.now()<deadline) { if(predicate()) return; await pause(); }
  throw Error('Timeout: '+label);
}
const picker=()=>document.querySelector('[data-omp-approval-mode] [aria-haspopup="listbox"]');
async function choose(mode) {
  await until(()=>picker() && !picker().disabled,'mode picker loaded');
  flushSync(()=>picker().click());
  await until(()=>document.querySelector('[role="option"]'),'approval modes');
  const option=Array.from(document.querySelectorAll('[role="option"]')).find(node=>node.textContent===i18n.t('settings.ompApproval.modes.'+mode));
  check(option,'localized '+mode+' choice'); flushSync(()=>option.click());
  await until(()=>!picker().disabled && settings.ompApprovalMode===mode,'mode saved');
  check(useAppStore.getState().settings.ompApprovalMode===mode,'later settings snapshots preserve mode');
}
async function run(mode,tool,pending) {
  scriptedRun={mode,tool,pending};
  await api.prompt({sessionId,content:tool});
  await until(()=>Boolean(document.querySelector('.permission-card'))===pending,'expected permission card state');
  if(pending) {
    const card=document.querySelector('.permission-card');
    check(card.textContent.includes(tool) && card.textContent.includes('/isolated/project'),'tool and workspace visible');
    check(!card.querySelector('[role="timer"]'),'approval has no deadline');
  }
}
async function decide(key,expected) {
  const card=document.querySelector('.permission-card');
  const action=Array.from(card.querySelectorAll('button')).find(node=>node.textContent===i18n.t('permission.'+key));
  check(action,'actual '+key+' card button');
  const count=decisions.length;
  flushSync(()=>action.click()); flushSync(()=>action.click());
  await until(()=>decisions.length===count+1,'one approval response');
  check(decisions.at(-1).decision===expected,'correct '+expected+' wire decision');
  check(['deny','allowSession','allowAlways','allowOnce'].every(key=>Array.from(card.querySelectorAll('button')).find(node=>node.textContent===i18n.t('permission.'+key))?.disabled),'pending response locks every approval decision');
  finishDecision(); finishDecision=undefined;
  await until(()=>!document.querySelector('.permission-card'),'resolved card removed');
}
window.ompApprovalProbe=async()=>{
  await until(()=>picker() && !picker().disabled,'initial settings');
  check(picker().textContent.includes(i18n.t('settings.ompApproval.modes.write')),'default write despite global yolo');
  // Scripted engine replies are the external RPC boundary, not a second policy
  // implementation. Runtime process/CLI policy is covered by runtime tests.
  await run('write','read',false);
  await run('write','edit',true); await decide('allowOnce','allow-once');
  await run('write','edit',true); await decide('deny','deny');
  await run('write','bash',true); await decide('allowSession','allow-session');
  await run('write','edit',true); await decide('allowAlways','allow-always');
  await choose('always-ask');
  flushSync(()=>reopen());
  await until(()=>picker() && !picker().disabled,'reopened settings');
  check(picker().textContent.includes(i18n.t('settings.ompApproval.modes.always-ask')),'explicit always-ask readback');
  await run('always-ask','read',true); await decide('deny','deny');
  await run('always-ask','edit',true);
  const beforeCancel=decisions.length;
  await useAppStore.getState().abort();
  await until(()=>!document.querySelector('.permission-card'),'stop removes pending card');
  check(aborted.length===1 && aborted[0].sessionId===sessionId,'real store abort addresses correct session');
  check(decisions.length===beforeCancel,'cancel never approves pending request');
  await choose('yolo');
  flushSync(()=>reopen());
  await until(()=>picker() && !picker().disabled,'yolo reopened');
  check(picker().textContent.includes(i18n.t('settings.ompApproval.modes.yolo')),'explicit yolo readback');
  await run('yolo','read',false); await run('yolo','edit',false);
  await choose('write');
  await run('write','edit',true);
  await choose('yolo');
  check(document.querySelector('.permission-card'),'mode changes do not silently answer active approval');
  await decide('deny','deny');
  check(globalConfig.approvalMode==='yolo','global approval mode unchanged');
  return {writes,runs,decisions,aborted,globalMode:globalConfig.approvalMode};
};
`, "ompApprovalProbe");
  assert.deepEqual(result.writes.map((entry) => entry.mode), ["always-ask", "yolo", "write", "yolo"]);
  assert.deepEqual(result.decisions.map((entry) => entry.decision), ["allow-once", "deny", "allow-session", "allow-always", "deny", "deny"]);
  assert.equal(result.aborted.length, 1);
  assert.equal(result.globalMode, "yolo");
  assert.deepEqual(result.runs.filter((run) => !run.pending).map((run) => [run.mode, run.tool]), [["write", "read"], ["yolo", "read"], ["yolo", "edit"]]);
});
