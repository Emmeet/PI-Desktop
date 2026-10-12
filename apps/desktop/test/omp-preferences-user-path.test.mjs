import assert from "node:assert/strict";
import test from "node:test";
import { runOmpRendererProbe, rendererProbeUnavailable } from "./helpers/omp-renderer-probe.mjs";

test("OMP preferences save/readback, theme modes and safe prediction acceptance", { skip: rendererProbeUnavailable }, async () => {
  const result = await runOmpRendererProbe(`
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from '@pi-desktop/i18n';
import { IPC } from '@pi-desktop/shared';
import { OmpPreferencesPage } from './apps/desktop/src/features/settings/OmpPreferencesPage';
import { OmpThemeSync, setOmpThemeSync } from './apps/desktop/src/features/omp/OmpThemeSync';
import { OmpWordPrediction } from './apps/desktop/src/features/omp/OmpWordPrediction';
import { paintEditorValue, setEditorCaret } from './apps/desktop/src/features/chat/composer/editor';
import { useAppStore } from './apps/desktop/src/stores/app-store';

const listeners = new Set();
const writes = [];
const requests = [];
const feedback = [];
const runtimeControls = [];
let reads = 0;
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const predictionTimers = new Map();
let timerId = 1000000;
window.setTimeout = (callback, delay, ...args) => {
  if (delay !== 250) return nativeSetTimeout(callback, delay, ...args);
  const id = ++timerId;
  predictionTimers.set(id, () => callback(...args));
  return id;
};
window.clearTimeout = (id) => { if (!predictionTimers.delete(id)) nativeClearTimeout(id); };
async function pause() {
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
  const pending = [...predictionTimers.values()];
  predictionTimers.clear();
  pending.forEach((callback) => callback());
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
}
let values = {
  'theme.dark': 'titanium', 'theme.light': 'light', symbolPreset: 'unicode',
  'spelling.autocomplete': 'ngram', 'composer.predictions': false,
  'providers.cacheWarming': 'off', 'providers.anthropic.slowMode': 'off',
  'lsp.enabled': true, 'commit.mapBatchTokenBudget': 16000,
};
function changed(key) {
  for (const listener of listeners) listener({method:'omp.config.changed',params:{key,value:values[key]}});
}
window.piDesktop = {
  on(_channel, listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async invoke(channel, args) {
    if (channel === IPC.invoke.ompConfigGet) { ++reads; return {ok:true,data:{values:{...values}}}; }
    if (channel === IPC.invoke.ompConfigSet) {
      writes.push(args); values = {...values,[args.key]:args.value}; changed(args.key);
      return {ok:true,data:{ok:true,value:values[args.key]}};
    }
    if (channel === IPC.invoke.ompThemes) return {ok:true,data:{names:['titanium','light'],palettes:{titanium:{accent:'#ff8800',borderAccent:'#ffaa00'},light:{accent:'#334455'}}}};
    if (channel === IPC.invoke.ompCall) {
      const command = args.params.command;
      if (command.type === 'predict_word') return new Promise((resolve) => requests.push({sessionId:args.params.sessionId,command,resolve}));
      if (command.type === 'predict_word_feedback') { feedback.push({sessionId:args.params.sessionId,...command}); return {ok:true,data:{result:undefined}}; }
      if (command.type === 'set_cache_warming') { runtimeControls.push({sessionId:args.params.sessionId,...command}); return {ok:true,data:{result:{mode:command.mode}}}; }
    }
    throw Error('Unexpected fixture IPC '+channel);
  },
};
await i18n.use(initReactI18next).init({lng:'en',fallbackLng:'en',resources:{en:{translation:en}},interpolation:{escapeValue:false}});
useAppStore.setState({activeSessionId:'native-pi:fixture'});
let setDraft;
function ProbeEditor() {
  const editorRef = useRef(null);
  const [draft, update] = useState({text:'',cursor:0,composing:false});
  setDraft = (text, composing=false, cursor=text.length) => update({text,cursor,composing});
  useLayoutEffect(() => {
    const editor = editorRef.current;
    paintEditorValue(editor,draft.text,new Map(),()=>'',()=>{},()=>{},()=>{},()=>{});
    editor.focus({preventScroll:true}); setEditorCaret(editor,draft.cursor);
  },[draft]);
  return <>
    <div data-prediction-editor contentEditable ref={editorRef} />
    <OmpWordPrediction editorRef={editorRef} sessionId='native-pi:fixture' value={draft.text} cursor={draft.cursor} composing={draft.composing} blocked={false} paletteOpen={false}
      onAccept={(suffix) => { update({text:draft.text+suffix,cursor:draft.cursor+suffix.length,composing:false}); return true; }} />
  </>;
}
createRoot(document.getElementById('root')).render(<><OmpPreferencesPage/><OmpThemeSync/><ProbeEditor/></>);
async function until(predicate, description) {
  const deadline=performance.now()+5000;
  while(performance.now()<deadline) { if(predicate()) return; await pause(); }
  throw Error('Timeout: '+description);
}
const check = (condition,message) => { if(!condition) throw Error(message); };
async function clickControl(control) {
  control.scrollIntoView({block:'center',behavior:'instant'});
  await until(() => { const box=control.getBoundingClientRect(); return box.top>=0 && box.bottom<=window.innerHeight; }, 'control visible before click');
  await pause();
  flushSync(() => control.click());
}
window.ompP2Probe = async () => {
  await until(() => Array.from(document.querySelectorAll('[role="switch"]')).some((node)=>node.getAttribute('aria-label')===i18n.t('settings.ompPrefs.fields.lsp_enabled') && !node.disabled), 'loaded controls');
  const toggle = Array.from(document.querySelectorAll('[role="switch"]')).find((node) => node.getAttribute('aria-label')===i18n.t('settings.ompPrefs.fields.lsp_enabled'));
  check(toggle,'localized LSP accessible name'); await clickControl(toggle);
  await until(() => writes.some((entry) => entry.key==='lsp.enabled') && toggle.getAttribute('aria-checked')==='false', 'persisted LSP readback');
  const cache = Array.from(document.querySelectorAll('[aria-haspopup="listbox"]')).find((node) => node.getAttribute('aria-label')===i18n.t('settings.ompPrefs.fields.providers_cacheWarming'));
  await until(() => !cache.disabled, 'cache picker ready'); await clickControl(cache);
  await until(() => document.querySelector('[role="option"]'), 'cache options');
  const idle = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent===i18n.t('settings.ompPrefs.options.idle'));
  check(idle,'localized cache option'); flushSync(() => idle.click());
  await until(() => values['providers.cacheWarming']==='idle' && cache.textContent.includes(i18n.t('settings.ompPrefs.options.idle')), 'cache persisted readback');
  setOmpThemeSync(true);
  await until(() => document.documentElement.dataset.ompTheme==='light', 'light theme sync');
  check(document.documentElement.style.getPropertyValue('--ds-accent')==='#334455','light palette');
  document.documentElement.dataset.theme='dark';
  await until(() => document.documentElement.dataset.ompTheme==='titanium', 'dark theme transition');
  check(document.documentElement.style.getPropertyValue('--ds-accent')==='#ff8800','dark palette');
  setOmpThemeSync(false);
  await until(() => !document.documentElement.dataset.ompTheme, 'theme disable');
  check(!document.documentElement.style.getPropertyValue('--ds-accent'),'restored app accent');
  setOmpThemeSync(true);
  await until(() => document.documentElement.dataset.ompTheme==='titanium', 're-enable');
  values={...values,'theme.dark':'light'}; changed('theme.dark');
  await until(() => document.documentElement.dataset.ompTheme==='light', 'cross-window config theme update');
  values={...values,'theme.dark':'titanium'}; changed('theme.dark');
  await until(() => document.documentElement.dataset.ompTheme==='titanium', 'external dark theme readback');
  const darkPicker=Array.from(document.querySelectorAll('[aria-haspopup="listbox"]')).find((node)=>node.getAttribute('aria-label')===i18n.t('settings.ompPrefs.fields.theme_dark'));
  await until(()=>!darkPicker.disabled && darkPicker.textContent.includes('titanium'),'theme picker external readback'); await clickControl(darkPicker);
  await until(()=>document.querySelector('[role="option"]'),'theme picker options');
  flushSync(() => Array.from(document.querySelectorAll('[role="option"]')).find((node)=>node.textContent==='light').click());
  await until(()=>writes.some((entry)=>entry.key==='theme.dark' && entry.value==='light') && document.documentElement.dataset.ompTheme==='light','theme saved through picker');
  setDraft('hel');
  await until(() => requests.some((entry) => entry.command.text==='hel'), 'first word request');
  setDraft('hell');
  await until(() => requests.some((entry) => entry.command.text==='hell'), 'new word request');
  const old=requests.find((entry) => entry.command.text==='hel');
  const current=requests.find((entry) => entry.command.text==='hell');
  current.resolve({ok:true,data:{result:{suffix:'o'}}});
  await until(() => document.querySelector('[data-omp-prediction] strong')?.textContent==='o', 'current suffix');
  old.resolve({ok:true,data:{result:{suffix:'p'}}}); await pause();
  check(document.querySelector('[data-omp-prediction] strong')?.textContent==='o','stale suffix ignored');
  const editor=document.querySelector('[data-prediction-editor]');
  let competing=0; editor.addEventListener('keydown',()=>++competing);
  const tab=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}); editor.dispatchEvent(tab);
  await until(() => editor.textContent==='hello' && feedback.length===1, 'accepted prediction');
  check(tab.defaultPrevented && competing===0,'Tab consumed exactly once');
  check(feedback[0].sessionId==='native-pi:fixture' && feedback[0].suggestion==='o','correct backend feedback');
  await pause();
  const baseline=requests.length;
  for(const [text,composing] of [['/hello',false],['open @hello',false],['hello',true]]) {
    setDraft(text,composing); await pause();
    check(!document.querySelector('[data-omp-prediction]'),'no slash/@/IME hint');
  }
  check(requests.length===baseline,'slash/@/IME sends no requests');
  setDraft('unf');
  await until(() => requests.some((entry)=>entry.command.text==='unf'),'pending setting transition');
  values={...values,'spelling.autocomplete':'off'}; changed('spelling.autocomplete');
  await pause(); requests.find((entry)=>entry.command.text==='unf').resolve({ok:true,data:{result:{suffix:'inished'}}});
  await pause(); check(!document.querySelector('[data-omp-prediction]'),'disabled prediction drops pending result');
  values={...values,'spelling.autocomplete':'ngram'}; changed('spelling.autocomplete');
  setDraft('rea');
  await until(() => requests.some((entry)=>entry.command.text==='rea'),'reactivated settings');
  requests.find((entry)=>entry.command.text==='rea').resolve({ok:true,data:{result:{suffix:'dy'}}});
  await until(() => document.querySelector('[data-omp-prediction] strong')?.textContent==='dy','reactive engine restored');
  return {writes,reads,feedback,runtimeControls,predictionRequests:requests.length,theme:document.documentElement.dataset.ompTheme};
};
`, "ompP2Probe", process.env.OMP_P2_PREFS_SCREENSHOT);
  assert(result.writes.some((entry) => entry.key === "lsp.enabled" && entry.value === false));
  assert(result.writes.some((entry) => entry.key === "providers.cacheWarming" && entry.value === "idle"));
  assert(result.writes.some((entry) => entry.key === "theme.dark" && entry.value === "light"));
  assert.equal(result.feedback.length, 1);
  assert.deepEqual(result.runtimeControls, [{sessionId:'native-pi:fixture',type:'set_cache_warming',mode:'idle'}]);
  assert.equal(result.theme, "light");
});
