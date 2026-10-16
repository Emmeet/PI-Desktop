import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

test("production CSP, sandbox and IPC reject script injection and untrusted senders", {
  skip: process.platform !== "linux" && "Requires an isolated X server",
  timeout: 60_000,
}, async () => {
  const root = repositoryRoot();
  const temp = await mkdtemp(join(tmpdir(), "omp-renderer-security-"));
  try {
    const appDir = join(root, "apps/desktop");
    const renderer = join(appDir, "out/renderer");
    const html = await readFile(join(renderer, "index.html"), "utf8");
    const policy = html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
    const importMap = html.match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0];
    assert(policy && importMap, "Build the production desktop before security tests");
    await cp(join(renderer, "renderer-host"), join(temp, "renderer-host"), { recursive: true });
    await build({
      stdin: { contents: `export { publishRendererHostModules, RENDERER_HOST_KEY } from ${JSON.stringify(join(appDir, "src/plugins/renderer-host/import-map.ts"))};`, resolveDir: appDir },
      bundle: true, platform: "browser", format: "esm", outfile: join(temp, "host.js"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(join(temp, "index.html"), `<!doctype html><html><head>${policy}${importMap}</head><body><script type="module" src="probe.js"></script></body></html>`);
    await writeFile(join(temp, "probe.js"), `
import { publishRendererHostModules, RENDERER_HOST_KEY } from './host.js';
publishRendererHostModules();
window.securityProbe = (async () => {
  const react = await import('react');
  const client = await import('react-dom/client');
  const sharedReact = react.useState === globalThis[RENDERER_HOST_KEY].react.useState && client.createRoot === globalThis[RENDERER_HOST_KEY].reactDomClient.createRoot;
  const nextViolation = () => new Promise(resolve => document.addEventListener('securitypolicyviolation', event => resolve(event.effectiveDirective), { once: true }));
  let violation = nextViolation();
  const script = document.createElement('script');
  script.textContent = 'globalThis.injectedInline = true';
  document.head.append(script);
  const inline = await violation;
  violation = nextViolation();
  let evalRejected = false;
  try { globalThis.eval('globalThis.injectedEval = true'); } catch { evalRejected = true; }
  const evaluation = await violation;
  violation = nextViolation();
  const blobUrl = URL.createObjectURL(new Blob(['globalThis.injectedBlob = true'], { type: 'text/javascript' }));
  let blobRejected = false;
  try { await import(blobUrl); } catch { blobRejected = true; } finally { URL.revokeObjectURL(blobUrl); }
  const blob = await violation;
  violation = nextViolation();
  let networkRejected = false;
  try { await fetch('http://127.0.0.1:' + new URLSearchParams(location.search).get('port') + '/private'); } catch { networkRejected = true; }
  const network = await violation;
  let eventInvokeRejected = false;
  try { await window.piDesktop.invoke(window.piDesktop.channels.event.ompEvent); } catch { eventInvokeRejected = true; }
  let invokeSubscribeRejected = false;
  try { window.piDesktop.on(window.piDesktop.channels.invoke.settingsGet, () => {}); } catch { invokeSubscribeRejected = true; }
  let unknownRejected = false;
  try { await window.piDesktop.invoke('not-a-desktop-channel'); } catch { unknownRejected = true; }
  return { sharedReact, inline, evaluation, blob, network, evalRejected, blobRejected, networkRejected,
    noInjection: !globalThis.injectedInline && !globalThis.injectedEval && !globalThis.injectedBlob,
    node: typeof globalThis.require, process: typeof globalThis.process,
    eventInvokeRejected, invokeSubscribeRejected, unknownRejected };
})();
`);
    const main = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { chatWindows } from ${JSON.stringify(join(appDir, "electron/main/chat-windows.ts"))};
import { assertRendererSender } from ${JSON.stringify(join(appDir, "electron/main/renderer-sender.ts"))};
import { IPC } from '@pi-desktop/shared';
const temp = ${JSON.stringify(temp)};
app.setPath('userData', join(temp, 'profile'));
app.whenReady().then(async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('must not be reached'); });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = pathToFileURL(join(temp, 'index.html'));
  url.searchParams.set('port', String(server.address().port));
  process.env.ELECTRON_RENDERER_URL = url.href;
  let launcher = null;
  const options = { show: false, webPreferences: { preload: ${JSON.stringify(join(appDir, "out/preload/index.cjs"))}, sandbox: true, contextIsolation: true, nodeIntegration: false } };
  try {
    for (const channel of [IPC.invoke.settingsGet, IPC.invoke.sessionList, IPC.invoke.pluginList]) ipcMain.handle(channel, event => {
      assertRendererSender(event, channel, { launcher, ownsWidget: () => false });
      return 'owned-data';
    });
    const mainWindow = new BrowserWindow(options);
    chatWindows.add(mainWindow);
    await mainWindow.loadURL(url.href);
    const result = await mainWindow.webContents.executeJavaScript('window.securityProbe');
    assert.deepEqual(result, { sharedReact:true, inline:'script-src-elem', evaluation:'script-src', blob:'script-src-elem', network:'connect-src', evalRejected:true, blobRejected:true, networkRejected:true, noInjection:true, node:'undefined', process:'undefined', eventInvokeRejected:true, invokeSubscribeRejected:true, unknownRejected:true });
    assert.equal(requests, 0, 'CSP must prevent loopback requests, not merely reject responses');
    const preferences = mainWindow.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    const command = channel => 'window.piDesktop.invoke(' + JSON.stringify(channel) + ')';
    assert.equal(await mainWindow.webContents.executeJavaScript(command(IPC.invoke.sessionList)), 'owned-data');
    const outsider = new BrowserWindow(options);
    await outsider.loadURL(url.href);
    await assert.rejects(outsider.webContents.executeJavaScript(command(IPC.invoke.sessionList)), /owned desktop main frame/);
    launcher = new BrowserWindow(options);
    const launchUrl = new URL(url.href);
    launchUrl.searchParams.set('surface', 'plugin-launcher');
    await launcher.loadURL(launchUrl.href);
    assert.equal(await launcher.webContents.executeJavaScript(command(IPC.invoke.pluginList)), 'owned-data');
    await assert.rejects(launcher.webContents.executeJavaScript(command(IPC.invoke.sessionList)), /owned desktop main frame/);
    await mainWindow.loadURL(launchUrl.href);
    await assert.rejects(mainWindow.webContents.executeJavaScript(command(IPC.invoke.sessionList)), /trusted chat main frame/);
    console.log('RENDERER_SECURITY_PROBE ' + JSON.stringify({ ...result, requests, rejectsOutsider:true, rejectsWrongSurface:true, rejectsNavigation:true }));
    app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
  finally { server.close(); }
});`;
    await build({ stdin: { contents: main, resolveDir: root }, bundle: true, platform: "node", format: "esm", external: ["electron"], alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts") }, outfile: join(temp, "main.mjs") });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.DISPLAY;
    const child = spawn("xvfb-run", ["-a", resolveElectronBinary(root).electronBinary, join(temp, "main.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    assert.match(output, /RENDERER_SECURITY_PROBE/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
