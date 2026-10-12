import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

// Native windows run only on a private X server, never the user's desktop.
test("trusted independent chat windows route controls, fanout and reject unrelated frames", { skip: process.platform !== "linux" && "This smoke requires an isolated X server", timeout: 45000 }, async () => {
  const root = repositoryRoot();
  const temp = await mkdtemp(join(tmpdir(), "omp-multiwindow-"));
  try {
    await mkdir(join(temp, "main"));
    await mkdir(join(temp, "preload"));
    await writeFile(join(temp, "preload/index.cjs"), `const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('windowProbe',{invoke:(channel,payload)=>ipcRenderer.invoke(channel,payload),getFanout:()=>globalThis.fanout,on:(channel)=>{ipcRenderer.on(channel,(_event,payload)=>{globalThis.fanout=payload;});}});`);
    await writeFile(join(temp, "chat.html"), "<!doctype html><html><body>Independent chat fixture</body></html>");
    const source = `
      import assert from 'node:assert/strict';
      import {app,BrowserWindow,ipcMain,globalShortcut} from 'electron';
      import {pathToFileURL} from 'node:url';
      import {join} from 'node:path';
      import {createChatWindow,chatWindows,applyFocusChatShortcut} from '${join(root, "apps/desktop/electron/main/chat-windows.ts")}';
      import {registerWindowIpc} from '${join(root, "apps/desktop/electron/main/ipc/window-ipc.ts")}';
      import {IPC} from '@pi-desktop/shared';
      app.setPath('userData',join(${JSON.stringify(temp)},'profile'));
      process.env.ELECTRON_RENDERER_URL=pathToFileURL(join(${JSON.stringify(temp)},'chat.html')).href;
      app.whenReady().then(async()=>{
        const errors=[];
        try{
          const first=await createChatWindow(async()=>{},error=>errors.push(String(error)));
          const second=await createChatWindow(async()=>{},error=>errors.push(String(error)));
          registerWindowIpc({registrar:{ipcMain,handle:(channel,fn)=>ipcMain.handle(channel,(_e,...args)=>fn(...args)),handleWithEvent:(channel,fn)=>ipcMain.handle(channel,fn),assertMainWindowSender:e=>{chatWindows.sender(e);},assertChatWindowSender:e=>{chatWindows.sender(e);}},getMainWindow:()=>first,getWorkPanelReservationWidth:()=>0,setWorkPanelReservationWidth:()=>{},setWorkPanelReservation:()=>{},getWorkPanelChatWidthSetter:()=>null,applyCloseBehavior:()=>{},getCloseBehavior:()=> 'tray',markMenuRendererReady:()=>true,executeNativeMenuAction:()=>{},setTraySessionPreferences:async()=>{}});
          await first.webContents.executeJavaScript('window.selectedSession="first"');
          await second.webContents.executeJavaScript('window.selectedSession="second"');
          assert.equal(await first.webContents.executeJavaScript('window.selectedSession'),'first');
          assert.equal(await second.webContents.executeJavaScript('window.selectedSession'),'second');
          await first.webContents.executeJavaScript('window.windowProbe.on('+JSON.stringify(IPC.event.ompEvent)+')');
          await second.webContents.executeJavaScript('window.windowProbe.on('+JSON.stringify(IPC.event.ompEvent)+')');
          chatWindows.broadcast(IPC.event.ompEvent,{method:'omp.config.changed'});
          for (const win of [first, second]) await win.webContents.executeJavaScript('new Promise(resolve=>{const check=()=>window.windowProbe.getFanout()?resolve():requestAnimationFrame(check);check();})');
          assert.deepEqual(await first.webContents.executeJavaScript('window.windowProbe.getFanout()'),{method:'omp.config.changed'});
          assert.deepEqual(await second.webContents.executeJavaScript('window.windowProbe.getFanout()'),{method:'omp.config.changed'});
          applyFocusChatShortcut({focusChatWindow:'Ctrl+Alt+Shift+F10'},async()=>false,error=>errors.push(String(error)));
          assert.equal(globalShortcut.isRegistered('Control+Alt+Shift+F10'),true,'configured native global accelerator must register');
          applyFocusChatShortcut({focusChatWindow:null},async()=>false,error=>errors.push(String(error)));
          assert.equal(globalShortcut.isRegistered('Control+Alt+Shift+F10'),false);
          // A native control invoke belongs to its caller, not the original window.
          const command='window.windowProbe.invoke('+JSON.stringify(IPC.invoke.nativeMenuAction)+', {action:"zoomIn"})';
          await second.webContents.executeJavaScript(command);
          assert.equal(first.webContents.getZoomLevel(),0,'native action must not change the original window');
          assert.equal(second.webContents.getZoomLevel(),0.5,'native action belongs to its sender');
          await first.webContents.executeJavaScript('new Promise(resolve=>{const frame=document.createElement("iframe");frame.onload=()=>resolve();document.body.append(frame);})');
          const childFrame=first.webContents.mainFrame.frames[0];
          assert.ok(childFrame);
          assert.throws(()=>chatWindows.sender({sender:first.webContents,senderFrame:childFrame}),/trusted chat main frame/);
          const outsider=new BrowserWindow({show:false,webPreferences:{preload:join(${JSON.stringify(temp)},'preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
          await outsider.loadFile(join(${JSON.stringify(temp)},'chat.html'));
          await assert.rejects(outsider.webContents.executeJavaScript(command),/trusted chat main frame/);
          outsider.destroy();
          await new Promise((resolve,reject)=>{
            second.once('closed',resolve);
            void second.webContents.executeJavaScript('window.windowProbe.invoke('+JSON.stringify(IPC.invoke.windowControl)+', {action:"close"})').catch(error=>{if(!second.isDestroyed())reject(error);});
          });
          assert.equal(chatWindows.list().length,1);
          chatWindows.broadcast(IPC.event.ompEvent,{method:'after-close'});
          await new Promise(resolve=>{first.once('closed',resolve);first.close();});
          assert.equal(chatWindows.list().length,0);
          assert.deepEqual(errors,[]);
          console.log('OMP_WINDOW_PROBE '+JSON.stringify({independent:true,senderControls:true,rejectsOutsider:true,cleanup:true}));
          app.exit(0);
        }catch(error){console.error(error.stack||error);app.exit(1);}
      });
    `;
    await build({stdin:{contents:source,resolveDir:root,loader:"ts"},outfile:join(temp,"main/probe.mjs"),bundle:true,platform:"node",format:"esm",external:["electron"],alias:{"@pi-desktop/shared":join(root,"packages/shared/src/index.ts")}});
    const {electronBinary}=resolveElectronBinary(root);
    const env={...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.DISPLAY;
    const child=spawn("xvfb-run",["-a",electronBinary,join(temp,"main/probe.mjs")],{env,stdio:["ignore","pipe","pipe"]});
    let output="";
    for(const stream of [child.stdout,child.stderr]) stream.on("data",chunk=>{output+=String(chunk);});
    const timer=setTimeout(()=>child.kill("SIGKILL"),35000);
    let code;
    try{code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});}finally{clearTimeout(timer);}
    assert.equal(code,0,output);
    assert.match(output,/OMP_WINDOW_PROBE/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
