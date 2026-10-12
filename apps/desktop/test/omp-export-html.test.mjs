import assert from "node:assert/strict";
import test from "node:test";
import {build} from "esbuild";
import {mkdtemp,writeFile,readFile,rm,symlink,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const temp=await mkdtemp(join(tmpdir(),"omp-html-export-"));
const state={choice:{canceled:false,filePath:join(temp,"saved.html")},opened:[],revealed:[],calls:[],owner:{isDestroyed:()=>false}};
globalThis.ompExportTest=state;
await build({entryPoints:[new URL("../electron/main/ipc/omp-extras-ipc.ts",import.meta.url).pathname],outfile:join(temp,"extras.mjs"),bundle:true,platform:"node",format:"esm",alias:{"@pi-desktop/shared":new URL("../../../packages/shared/src/index.ts",import.meta.url).pathname},plugins:[{name:"native-and-engine-boundaries",setup(b){
 b.onResolve({filter:/^electron$/},()=>({path:"native",namespace:"fixtures"}));
 b.onResolve({filter:/omp-capability-sync$/},()=>({path:"engine",namespace:"fixtures"}));
 b.onLoad({filter:/.*/,namespace:"fixtures"},({path})=>({loader:"js",contents:path==="native"?`
 const state=globalThis.ompExportTest;
 export const app={getPath:()=>${JSON.stringify(temp)}};
 export const BrowserWindow={fromWebContents:()=>state.owner};
 export const dialog={showSaveDialog:async(owner,options)=>{state.dialogOwner=owner;state.dialogOptions=options;return state.choice;}};
 export const shell={openPath:async path=>{state.opened.push(path);return '';},showItemInFolder:path=>state.revealed.push(path)};
 `:`export const ompPackageDir=()=>null; export const bunBinary=()=> 'bun'; export const runOmp=async()=> '{}'; export const runOmpConfig=async()=>{};`}));
}}]});
const {registerOmpExtrasIpc}=await import(pathToFileURL(join(temp,"extras.mjs")));
const {IPC}=await import("../../../packages/shared/src/protocol.ts");
const handlers=new Map();
const event={sender:{isDestroyed:()=>false},senderFrame:{}};
const sidecar={call:async(method,input)=>{
 state.calls.push({method,input});
 await writeFile(input.command.outputPath,"<!doctype html><html><body>Exported session</body></html>");
 return {result:{path:state.returnPath??input.command.outputPath}};
}};
registerOmpExtrasIpc({registrar:{handle:(channel,fn)=>handlers.set(channel,fn),handleWithEvent:(channel,fn)=>handlers.set(channel,fn),assertMainWindowSender:e=>{if(e!==event)throw new Error("untrusted sender");}},getSidecar:()=>sidecar});
const invoke=(channel,input,e=event)=>handlers.get(channel)(e,input);
test.after(async()=>{delete globalThis.ompExportTest;await rm(temp,{recursive:true,force:true});});

test("save runs actual export contract and grants only the selected local HTML",async()=>{
 const result=await invoke(IPC.invoke.ompExportHtml,{sessionId:"session",title:"../unsafe:title"});
 assert.equal(result.path,state.choice.filePath);
 assert.equal(state.dialogOwner,state.owner);
 assert.deepEqual(state.calls[0],{method:"omp.session.command",input:{sessionId:"session",command:{type:"export_html",outputPath:state.choice.filePath}}});
 assert.match(await readFile(result.path,"utf8"),/<html>/);
 await invoke(IPC.invoke.ompOpenExport,{path:result.path});
 await invoke(IPC.invoke.ompRevealExport,{path:result.path});
 assert.deepEqual(state.opened,[result.path]);
 assert.equal(state.revealed.at(-1),result.path);
 await assert.rejects(invoke(IPC.invoke.ompOpenExport,{path:join(temp,"not-selected.html")}),/not authorized/);
 await assert.rejects(invoke(IPC.invoke.ompRevealExport,{path:result.path},{}),/untrusted sender/);
});

test("cancelled dialog never dispatches engine export or grants a path",async()=>{
 const count=state.calls.length;
 state.choice={canceled:true,filePath:join(temp,"cancelled.html")};
 assert.deepEqual(await invoke(IPC.invoke.ompExportHtml,{sessionId:"session"}),{path:null});
 assert.equal(state.calls.length,count);
 await assert.rejects(invoke(IPC.invoke.ompOpenExport,{path:state.choice.filePath}),/not authorized/);
});

test("unexpected engine path fails closed rather than granting or revealing it",async()=>{
 state.choice={canceled:false,filePath:join(temp,"requested.html")};
 state.returnPath=join(temp,"unexpected.html");
 const count=state.revealed.length;
 await assert.rejects(invoke(IPC.invoke.ompExportHtml,{sessionId:"session"}),/unexpected HTML export destination/);
 assert.equal(state.revealed.length,count);
 await assert.rejects(invoke(IPC.invoke.ompOpenExport,{path:state.choice.filePath}),/not authorized/);
 delete state.returnPath;
});

test("canonical grant cannot be redirected by replacing the saved path with a symlink",async()=>{
 const selected=join(temp,"canonical.html");
 state.choice={canceled:false,filePath:selected};
 await invoke(IPC.invoke.ompExportHtml,{sessionId:"session"});
 const other=join(temp,"other.html");
 await writeFile(other,"<html>different file</html>");
 await unlink(selected);
 await symlink(other,selected);
 await assert.rejects(invoke(IPC.invoke.ompOpenExport,{path:selected}),/not authorized/);
});
