import assert from "node:assert/strict";
import test from "node:test";
import { runOmpRendererProbe, rendererProbeUnavailable } from "./helpers/omp-renderer-probe.mjs";

const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {OmpModelPicker} from './apps/desktop/src/features/chat/composer/OmpModelPicker';
import {runOmpShortcut,isOmpShortcut} from './apps/desktop/src/features/omp/OmpHotkeys';
import {useAppStore} from './apps/desktop/src/stores/app-store';
import {IPC,KEYBOARD_SHORTCUTS,keybindingMatchesEvent,resolveKeybinding} from '@pi-desktop/shared';
const effects=[];
const models=['one','two','three'].map(id=>({provider:'fixture',id,name:id,reasoning:true,thinkingLevels:['off','low','high']}));
window.piDesktop={invoke:async(channel,args)=>{
 if(channel===IPC.invoke.ompModelsList)return {ok:true,data:{models,selected:{provider:'fixture',modelId:'one'},defaultModel:{provider:'fixture',modelId:'one'},thinkingLevel:'off'}};
 if(channel===IPC.invoke.ompModelSet){effects.push({type:'model',value:args.modelId});return {ok:true,data:{session:null}};}
 if(channel===IPC.invoke.ompThinkingSet){effects.push({type:'thinking',value:args.level});return {ok:true,data:{session:null}};}
 if(channel===IPC.invoke.ompFastGet)return {ok:true,data:{enabled:false}};
 throw new Error('Unexpected fixture IPC '+channel);
},on:()=>()=>{}};
const waitFor=condition=>new Promise((resolve,reject)=>{
 const started=performance.now();
 const check=()=>{if(condition())resolve();else if(performance.now()-started>5000)reject(new Error('Timed out waiting for picker state: '+JSON.stringify({effects,menus:document.querySelectorAll('[role="menu"]').length,thinking:!!document.querySelector('[data-omp-thinking-picker="true"]')})));else requestAnimationFrame(check);};check();
});
window.ompHotkeyProbe=async()=>{
 const root=createRoot(document.getElementById('root'));
 root.render(<div className='composer-stack'><OmpModelPicker t={key=>key} session={null} controlsBlocked={false} onCloseOtherMenus={()=>{}} onSessionChanged={()=>{}} showToast={()=>{}}/><textarea id='composer'/></div>);
 await waitFor(()=>document.querySelector('[data-omp-thinking-picker="true"]'));
 const input=document.getElementById('composer');input.focus();
 const menuClosed=()=>document.querySelector('[data-omp-model-picker="true"]')?.getAttribute('aria-expanded')==='false';
 const forward=runOmpShortcut('ompCycleModel',input);
 await waitFor(()=>effects.length===1&&menuClosed());
 const backward=runOmpShortcut('ompCycleModelBackward',input);
 await waitFor(()=>effects.length===2&&menuClosed());
 const thinking=runOmpShortcut('ompCycleThinking',input);
 await waitFor(()=>effects.length===3&&document.querySelector('[data-omp-thinking-picker="true"]')?.getAttribute('aria-expanded')==='false');
 const overlay=document.createElement('div');overlay.setAttribute('role','dialog');overlay.textContent='Modal';document.body.append(overlay);
 const blocked=runOmpShortcut('ompSelectModel',input);overlay.remove();
 const composing=runOmpShortcut('ompCycleModel',input,new KeyboardEvent('keydown',{key:'p',ctrlKey:true,isComposing:true}));
 const repeat=runOmpShortcut('ompCycleModel',input,new KeyboardEvent('keydown',{key:'p',ctrlKey:true,repeat:true}));
 const consumedEvent=new KeyboardEvent('keydown',{key:'p',ctrlKey:true,cancelable:true});consumedEvent.preventDefault();
 const consumed=runOmpShortcut('ompCycleModel',input,consumedEvent);
 let interrupted=0;
 useAppStore.setState({activeSessionId:'fixture-session',isRunning:true,abort:async()=>{interrupted++;}});
 const interrupt=runOmpShortcut('ompInterrupt',input);
 const cycle=KEYBOARD_SHORTCUTS.find(s=>s.id==='ompCycleModel');
 const customized=resolveKeybinding(cycle,{ompCycleModel:'Alt+Y'},'darwin');
 const customMatches=keybindingMatchesEvent(customized,new KeyboardEvent('keydown',{key:'y',code:'KeyY',altKey:true}),'darwin');
 const defaultMatches=keybindingMatchesEvent(resolveKeybinding(cycle,{},'darwin'),new KeyboardEvent('keydown',{key:'p',code:'KeyP',ctrlKey:true}),'darwin');
 root.unmount();
 return {effects,forward,backward,thinking,blocked,composing,repeat,consumed,interrupt,interrupted,customMatches,defaultMatches,registered:isOmpShortcut('ompCycleModelBackward')};
};
`;

test("actual OMP picker cycles in both directions, applies reasoning and respects overlays/customization", {skip:rendererProbeUnavailable,timeout:60000}, async()=>{
 const result=await runOmpRendererProbe(source,"ompHotkeyProbe");
 assert.equal(result.forward,true);
 assert.equal(result.backward,true);
 assert.equal(result.thinking,true);
 assert.deepEqual(result.effects,[{type:"model",value:"two"},{type:"model",value:"one"},{type:"thinking",value:"low"}]);
 assert.equal(result.blocked,false);
 assert.equal(result.composing,false);
 assert.equal(result.repeat,false);
 assert.equal(result.consumed,false);
 assert.equal(result.interrupt,true);
 assert.equal(result.interrupted,1);
 assert.equal(result.customMatches,true);
 assert.equal(result.defaultMatches,true);
 assert.equal(result.registered,true);
});
