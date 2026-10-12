import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temp = await mkdtemp(join(tmpdir(), "omp-host-tools-"));
const state = { text: "", reads: 0, writes: [], opens: [], screenshots: [], approvals: [], response: 1 };
globalThis.ompHostTest = state;
await build({
  entryPoints: [new URL("../electron/main/omp-host-tools.ts", import.meta.url).pathname],
  outfile: join(temp, "host.mjs"), bundle: true, format: "esm", platform: "node",
  alias: { "@pi-desktop/i18n": new URL("../../../packages/i18n/src/index.ts", import.meta.url).pathname },
  plugins: [{ name: "native-boundary", setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "native" }));
    b.onLoad({ filter: /.*/, namespace: "native" }, () => ({ contents: `
      const state = globalThis.ompHostTest;
      export const app = { getLocale: () => 'en' };
      export const dialog = { showMessageBox: async options => {
        state.approvals.push(options);
        if (state.approve) return state.approve(options);
        return { response: state.response };
      }};
      export const clipboard = { readText: () => { state.reads++; return state.text; }, writeText: text => { state.text = text; state.writes.push(text); } };
      export const shell = { openExternal: async url => { state.opens.push(url); }, openPath: async path => { state.opens.push(path); return ''; } };
      const image = value => ({ isEmpty: () => false, getSize: () => ({width: 800,height: 600}), toPNG: () => Buffer.from(value) });
      export const screen = { getPrimaryDisplay: () => ({ id: 7, size: {width:800,height:600} }) };
      export const desktopCapturer = { getSources: async () => {
        state.screenshots.push('capture');
        if (state.capture) return state.capture();
        return [{display_id:'9',thumbnail:image('secondary')},{display_id:'7',thumbnail:image('primary')}];
      }};
    `, loader: "js" }));
  } }],
});
const host = await import(pathToFileURL(join(temp, "host.mjs")));
const replies = [];
const sidecar = { call: async (method, payload) => { replies.push({ method, ...payload }); } };
const call = (sessionId, id, toolName, args = {}) => host.handleOmpHostRequest(sidecar, { sessionId, frame: { type: "host_tool_call", id, toolCallId: `tool-${id}`, toolName, arguments: args } });
const uri = (id, operation, url, content) => host.handleOmpHostRequest(sidecar, { sessionId: "a", frame: { type: "host_uri_request", id, operation, url, ...(content === undefined ? {} : { content }) } });

test.after(async () => { delete globalThis.ompHostTest; await rm(temp, { recursive: true, force: true }); });

test("screenshot uses the actual primary display and returns omp image content", async () => {
  await call("a", "screen", "desktop_screenshot");
  assert.equal(replies.at(-1).frame.type, "host_tool_result");
  assert.equal(Buffer.from(replies.at(-1).frame.result.content[1].data, "base64").toString(), "primary");
});

test("clipboard tools and URI operations obey the real result contract", async () => {
  await call("a", "write", "desktop_clipboard_write", { text: "hello" });
  await uri("read-uri", "read", "clipboard://text");
  assert.equal(replies.at(-1).frame.content, "hello");
  assert.equal(replies.at(-1).frame.contentType, "text/plain");
  await uri("write-uri", "write", "clipboard://", "URI text");
  assert.deepEqual(replies.at(-1).frame, { type: "host_uri_result", id: "write-uri" });
  assert.equal(state.text, "URI text");
});

test("approved open uses the safe URL helper and existing absolute paths", async () => {
  await call("a", "open-url", "desktop_open", { target: "https://example.com" });
  assert.equal(state.opens.at(-1), "https://example.com/");
  const path = join(temp, "document.txt");
  await writeFile(path, "Local file");
  await call("a", "open-file", "desktop_open", { target: path });
  assert.equal(state.opens.at(-1), path);
});

test("malformed/disallowed native requests never perform side effects", async () => {
  const before = { opens: state.opens.length, writes: state.writes.length, reads: state.reads };
  await call("a", "bad-text", "desktop_clipboard_write", { text: 12 });
  assert.equal(replies.at(-1).frame.isError, true);
  await call("a", "bad-url", "desktop_open", { target: "javascript:alert(1)" });
  assert.equal(replies.at(-1).frame.isError, true);
  await uri("bad-uri", "delete", "clipboard://text?secret=1");
  assert.equal(replies.at(-1).frame.isError, true);
  assert.match(replies.at(-1).frame.error, /clipboard/i);
  assert.deepEqual({ opens: state.opens.length, writes: state.writes.length, reads: state.reads }, before);
  await assert.rejects(host.handleOmpHostRequest(sidecar, { sessionId: {}, frame: {id:"x"} }), /Malformed/);
});

test("native approval denial prevents clipboard access", async () => {
  state.response = 0;
  const before = state.reads;
  await call("a", "denied", "desktop_clipboard_read");
  assert.equal(replies.at(-1).frame.isError, true);
  assert.equal(state.reads, before);
  state.response = 1;
});

test("cancellation and cleanup are session scoped and stop deferred side effects", async () => {
  const decisions = [];
  state.approve = options => new Promise(resolve => {
    decisions.push(() => resolve({ response: 1 }));
    options.signal.addEventListener("abort", () => resolve({response:0}), {once:true});
  });
  const first = call("a", "same", "desktop_clipboard_write", {text:"cancelled"});
  const second = call("b", "same", "desktop_clipboard_write", {text:"other session"});
  await host.handleOmpHostRequest(sidecar, {sessionId:"a",frame:{type:"host_tool_cancel",id:"cancel",targetId:"same"}});
  decisions[1]();
  await Promise.all([first, second]);
  assert.equal(state.text, "other session");
  assert.equal(replies.some(reply => reply.sessionId === "a" && reply.frame.id === "same"), false);
  const closed = call("a", "closed", "desktop_clipboard_write", {text:"closed"});
  host.cancelOmpHostRequests(sidecar, "a");
  await closed;
  assert.equal(state.text, "other session");
  delete state.approve;
});

test("response transport failures are surfaced, not converted or swallowed", async () => {
  await assert.rejects(host.handleOmpHostRequest({call:async () => {throw new Error("transport lost");}}, {sessionId:"a",frame:{type:"host_uri_request",id:"lost",operation:"read",url:"clipboard://"}}), /transport lost/);
});
