import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const storageDirectory = fileURLToPath(new URL("../electron/main/storage/", import.meta.url));
const result = await build({
  stdin: { contents: ['files', 'preferences', 'bootstrap', 'ipc', 'legacy-import'].map((name) => `export * from "./${name}";`).join("\n") + '\nexport { IPC } from "@pi-desktop/shared";\nexport { catalogs } from "@pi-desktop/i18n";', resolveDir: storageDirectory, loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "external-storage-boundaries", setup(builder) {
    builder.onResolve({ filter: /^@pi-desktop\/shared$/ }, () => ({ path: fileURLToPath(new URL("../../../packages/shared/src/protocol.ts", import.meta.url)) }));
    builder.onResolve({ filter: /^@pi-desktop\/i18n$/ }, () => ({ path: fileURLToPath(new URL("../../../packages/i18n/src/index.ts", import.meta.url)) }));
    builder.onResolve({ filter: /^(electron|node:child_process)$|host-process$/ }, (args) => ({ path: args.path, namespace: "storage-test-boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "storage-test-boundary" }, (args) => {
      if (args.path === "electron") return { contents: "export const app = globalThis.__storageHarness.app; export const dialog = globalThis.__storageHarness.dialog; export const BrowserWindow = globalThis.__storageHarness.BrowserWindow;" };
      if (args.path === "node:child_process") return { contents: "export function execFile(command, args, options, callback) { globalThis.__storageHarness.execFile(command, args, options, callback); }" };
      return { contents: "export function resolveHostBinary() { return '/fake/host-core'; }" };
    });
  } }],
});

const exitSignal = new Error("test process exited");
const harness = {
  anchor: "", appData: "", selection: null, paths: [], windows: [], errors: [], restarts: 0, hostError: null,
  commandSwitches: [],
  app: { commandLine: { hasSwitch: (name) => harness.commandSwitches.includes(name) }, getPath: (name) => name === "temp" ? maintenanceTemp : name === "appData" ? harness.appData : harness.anchor, getLocale: () => "en", setPath: (...value) => harness.paths.push(value), whenReady: async () => {}, relaunch: () => { harness.restarts++; }, exit: () => { throw exitSignal; } },
  dialog: { showOpenDialog: async () => ({ canceled: harness.selection === null, filePaths: [harness.selection] }), showMessageBox: async (...value) => { harness.errors.push(value); return { response: 0 }; } },
  BrowserWindow: class {
    constructor(options) { this.options = options; this.scripts = []; harness.windows.push(this); this.webContents = { setWindowOpenHandler: () => {}, on: () => {}, executeJavaScript: async (script) => { this.scripts.push(script); } }; }
    setMenu() {}
    async loadURL(url) { this.url = url; }
    isDestroyed() { return false; }
  },
  execFile: (_command, _args, _options, callback) => callback(harness.hostError, "", ""),
};
globalThis.__storageHarness = harness;
const bundleDirectory = await mkdtemp(join(tmpdir(), "pi-storage-bundle-"));
const maintenanceTemp = await mkdtemp(join(tmpdir(), "pi-storage-session-"));
after(() => Promise.all([
  rm(bundleDirectory, { recursive: true, force: true }),
  rm(maintenanceTemp, { recursive: true, force: true }),
]));
const bundleFile = join(bundleDirectory, "storage-maintenance.mjs");
await writeFile(bundleFile, result.outputFiles[0].text);
const storage = await import(pathToFileURL(bundleFile).href);

async function fixture(t, { dataMissing = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-storage-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = { data: join(root, "old-data"), browser: join(root, "old-browser") };
  const target = join(root, "destination");
  const anchor = roots.browser;
  await Promise.all([mkdir(roots.browser), mkdir(target), ...(dataMissing ? [] : [mkdir(roots.data)])]);
  return { root, roots, target, anchor };
}
async function put(path, contents = "preserve this data", mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode });
  return path;
}
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const migrate = (value, overrides = {}) => storage.migrateFiles({ source: value.roots, target: value.target, anchor: value.anchor, id: randomUUID(), progress: () => {}, relocate: async () => {}, ...overrides });
function resetHarness(anchor) {
  harness.anchor = anchor; harness.appData = anchor; harness.paths = []; harness.windows = []; harness.errors = [];
  harness.restarts = 0; harness.hostError = null; harness.selection = null; harness.commandSwitches = [];
}
function registerHandlers() {
  const handlers = new Map();
  storage.registerStorageIpc({ registrar: { handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertMainWindowSender: (event) => { if (event !== "main") throw new Error("untrusted sender"); } }, getMainWindow: () => ({}), restart: () => { harness.restarts++; } });
  return (channel, input, event = "main") => handlers.get(storage.IPC.invoke[channel])(event, input);
}

test("cold migration copies real data, verifies hashes, preserves secret permissions and reports stages", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  const payload = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251));
  await put(join(value.roots.data, "sessions/chat.jsonl"), payload);
  await put(join(value.roots.data, "secrets.json"), "encrypted-test-secret", 0o600);
  await chmod(value.roots.data, 0o700);
  await put(join(value.roots.browser, "Local Storage/leveldb/test.ldb"), "browser state");
  await put(join(value.roots.browser, storage.STORAGE_PREFERENCE_FILE), "bootstrap pointer");
  await put(join(value.roots.browser, "SingletonLock"), "installation lock");
  const events = []; const relocations = [];
  const next = await migrate(value, { progress: (event) => events.push(event), relocate: async (...roots) => relocations.push(roots) });
  assert.equal(hash(await readFile(join(next.data, "sessions/chat.jsonl"))), hash(payload));
  assert.equal((await lstat(join(next.data, "secrets.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(next.data)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(next.browser, "Local Storage/leveldb/test.ldb"), "utf8"), "browser state");
  assert.equal(await exists(join(next.browser, storage.STORAGE_PREFERENCE_FILE)), false);
  assert.equal(await exists(join(next.browser, "SingletonLock")), false);
  assert.equal(await readFile(join(value.roots.data, "sessions/chat.jsonl")).then(hash), hash(payload));
  assert.deepEqual(relocations, [[value.roots.data, next.data]]);
  assert.deepEqual([...new Set(events.map((event) => event.stage))], ["scanning", "copying", "verifying", "relocating", "complete"]);
  assert.equal(events.at(-1).completedBytes, events.at(-1).totalBytes);
  assert.equal(events.at(-1).completedFiles, events.at(-1).totalFiles);
});

test("migration detects changed copy content before relocating persistent paths", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); await put(join(value.roots.data, "secrets.json"), "original");
  let corrupted = false; let relocated = false;
  await assert.rejects(migrate(value, { progress: (event) => {
    if (event.stage === "verifying" && !corrupted) {
      corrupted = true;
      // Synchronous corruption provides an explicit verification boundary without sleeps.
      createRequire(import.meta.url)("node:fs").writeFileSync(join(value.target, "data/secrets.json"), "corrupt");
    }
  }, relocate: async () => { relocated = true; } }), /changed|verification/);
  assert.equal(relocated, false);
  assert.equal(await readFile(join(value.roots.data, "secrets.json"), "utf8"), "original");
});

test("migration relocates internal absolute links and preserves external links", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); await put(join(value.roots.data, "sessions/current"), "session");
  await put(join(value.root, "outside"), "outside");
  await symlink(join(value.roots.data, "sessions/current"), join(value.roots.data, "absolute-link"));
  await symlink(join(value.root, "outside"), join(value.roots.data, "external-link"));
  const next = await migrate(value);
  assert.equal(await readlink(join(next.data, "absolute-link")), join(next.data, "sessions/current"));
  assert.equal(await readlink(join(next.data, "external-link")), join(value.root, "outside"));
});

test("relative links spanning data and browser roots retain their target after relocation", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.browser, "Local Storage/profile"), "linked browser data");
  await symlink(relative(value.roots.data, join(value.roots.browser, "Local Storage/profile")), join(value.roots.data, "browser-link"));
  const next = await migrate(value);
  assert.equal(await realpath(join(next.data, "browser-link")), join(next.browser, "Local Storage/profile"));
});

test("migration preserves external relative links and read-only files", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  const external = await put(join(value.root, "external-document"), "outside");
  await symlink(relative(value.roots.data, external), join(value.roots.data, "external-relative"));
  await put(join(value.roots.data, "plugins/installed/read-only.js"), "plugin source", 0o444);
  const next = await migrate(value);
  assert.equal(await realpath(join(next.data, "external-relative")), external);
  assert.equal((await lstat(join(next.data, "plugins/installed/read-only.js"))).mode & 0o777, 0o444);
  assert.equal(await readFile(join(next.data, "plugins/installed/read-only.js"), "utf8"), "plugin source");
});

test("migration re-reads and rejects a tampered read-only copy before relocating paths", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.data, "plugins/installed/read-only.js"), "plugin source", 0o444);
  const fs = createRequire(import.meta.url)("node:fs");
  let corrupted = false; let relocated = false;
  await assert.rejects(migrate(value, { progress: (event) => {
    if (event.stage !== "verifying" || corrupted) return;
    corrupted = true;
    // Verification has to compare real bytes: a read-only copy that was tampered
    // with after being written must still be detected, so the mode can never
    // stand in for the content check.
    const copy = join(value.target, "data/plugins/installed/read-only.js");
    fs.chmodSync(copy, 0o600);
    fs.writeFileSync(copy, "tampered after the copy");
    fs.chmodSync(copy, 0o444);
  }, relocate: async () => { relocated = true; } }), /changed|verification/);
  assert.equal(relocated, false);
  assert.equal(await readFile(join(value.roots.data, "plugins/installed/read-only.js"), "utf8"), "plugin source");
  assert.equal((await lstat(join(value.target, "data/plugins/installed/read-only.js"))).mode & 0o777, 0o444);
});

test("interrupted migration retries only the same claimed job and preserves the original", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); const id = randomUUID();
  await put(join(value.roots.data, "sessions/current"), "source session");
  await assert.rejects(migrate(value, { id, relocate: async () => { throw new Error("interrupted relocation"); } }), /interrupted/);
  await assert.rejects(migrate(value), /unrelated data|empty/);
  const next = await migrate(value, { id });
  assert.equal(await readFile(join(next.data, "sessions/current"), "utf8"), "source session");
  assert.equal(await readFile(join(value.roots.data, "sessions/current"), "utf8"), "source session");
});

test("target validation rejects nonempty, overlapping and symbolic-link directories", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.target, "unrelated"));
  await assert.rejects(storage.validateTarget(value.target, value.roots, value.anchor), /empty/);
  const nested = join(value.roots.data, "nested"); await mkdir(nested);
  await assert.rejects(storage.validateTarget(nested, value.roots, value.anchor), /separate/);
  await assert.rejects(storage.validateTarget(value.root, value.roots, value.anchor), /separate/);
  const alias = join(value.root, "alias"); await symlink(value.target, alias);
  await assert.rejects(storage.validateTarget(alias, value.roots, value.anchor), /symbolic link/);
  assert.equal(await readFile(join(value.target, "unrelated"), "utf8"), "preserve this data");
});

test("migration supports a clean installation whose data root does not yet exist", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t, { dataMissing: true });
  const next = await migrate(value);
  assert.equal((await lstat(next.data)).isDirectory(), true);
});

test("migration copies a symbolic-link source root without keeping the old root active", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.data, "sessions/current"), "source conversation");
  const alias = join(value.root, "data-alias");
  await symlink(value.roots.data, alias);
  value.roots = { ...value.roots, data: alias };
  const next = await migrate(value);
  assert.equal((await lstat(next.data)).isDirectory(), true);
  assert.equal((await lstat(next.data)).isSymbolicLink(), false);
  assert.equal(await readFile(join(next.data, "sessions/current"), "utf8"), "source conversation");
});

test("cache cleanup removes disposable caches while preserving sessions, secrets, plugin data and browser state", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  const caches = ["cache/thumbnails", "plugins/cache/download/pkg", "plugins/cache/backup/pkg", "openable-attachments/extracted"];
  const browserCaches = ["Cache/response", "Code Cache/script", "GPUCache/shader", "Partitions/plugin-1/Cache/response"];
  const protectedData = ["scratch/session/work.md", "sessions/current.jsonl", "secrets.json", "plugins/data/plugin-1/settings.json"];
  const protectedBrowser = ["Local Storage/leveldb/session.ldb", "Partitions/plugin-1/Local Storage/leveldb/config.ldb", "Cookies"];
  for (const path of caches) await put(join(value.roots.data, path), "1234");
  for (const path of browserCaches) await put(join(value.roots.browser, path), "1234");
  for (const path of protectedData) await put(join(value.roots.data, path), "durable");
  for (const path of protectedBrowser) await put(join(value.roots.browser, path), "durable");
  assert.equal(await storage.cacheSize(value.roots), (caches.length + browserCaches.length) * 4);
  await storage.clearCaches(value.roots);
  for (const path of caches) assert.equal(await exists(join(value.roots.data, path)), false, path);
  for (const path of browserCaches) assert.equal(await exists(join(value.roots.browser, path)), false, path);
  for (const path of protectedData) assert.equal(await readFile(join(value.roots.data, path), "utf8"), "durable", path);
  for (const path of protectedBrowser) assert.equal(await readFile(join(value.roots.browser, path), "utf8"), "durable", path);
  assert.equal(await storage.cacheSize(value.roots), 0);
});

test("cache cleanup does not follow plugin, partition or leaf cache links outside storage", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); const external = join(value.root, "external");
  await put(join(external, "cache/download/pkg"), "external");
  await put(join(external, "Cache/response"), "external");
  await symlink(external, join(value.roots.data, "plugins"));
  await symlink(join(external, "Cache"), join(value.roots.data, "cache"));
  await mkdir(join(value.roots.browser, "Partitions"));
  await symlink(external, join(value.roots.browser, "Partitions/plugin-link"));
  assert.equal(await storage.cacheSize(value.roots), 0);
  await storage.clearCaches(value.roots);
  assert.equal(await readFile(join(external, "cache/download/pkg"), "utf8"), "external");
  assert.equal(await readFile(join(external, "Cache/response"), "utf8"), "external");
});

test("cache cleanup rejects intermediate links into durable data even inside the same storage root", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.data, "sessions/download/current.jsonl"), "durable conversation");
  await mkdir(join(value.roots.data, "plugins"));
  await symlink(join(value.roots.data, "sessions"), join(value.roots.data, "plugins/cache"));
  await storage.clearCaches(value.roots);
  assert.equal(await readFile(join(value.roots.data, "sessions/download/current.jsonl"), "utf8"), "durable conversation");
  assert.equal(await storage.cacheSize(value.roots), 0);
});

test("cache cleanup refuses a leaf cache link that redirects to durable data in the same profile", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.data, "sessions/download/current.jsonl"), "durable conversation");
  await symlink(join(value.roots.data, "sessions"), join(value.roots.data, "cache"));
  assert.equal(await storage.cacheSize(value.roots), 0);
  await storage.clearCaches(value.roots);
  assert.equal(await readFile(join(value.roots.data, "sessions/download/current.jsonl"), "utf8"), "durable conversation");
  assert.equal((await lstat(join(value.roots.data, "cache"))).isSymbolicLink(), true);
});

test("backup removal protects active storage and the installation bootstrap anchor", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); const active = { data: join(value.target, "data"), browser: join(value.target, "browser") };
  await Promise.all([mkdir(active.data), mkdir(active.browser)]);
  await put(join(active.data, "session"), "active");
  await put(join(value.roots.data, "old-session"), "old");
  await put(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), "pointer");
  await put(join(value.anchor, "SingletonLock"), "lock");
  await put(join(value.anchor, "Local Storage/old"), "old browser");
  await assert.rejects(storage.removeBackups([active], active, value.anchor), /active storage/);
  await storage.removeBackups([value.roots], active, value.anchor);
  assert.equal(await exists(value.roots.data), false);
  assert.equal(await readFile(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), "utf8"), "pointer");
  assert.equal(await readFile(join(value.anchor, "SingletonLock"), "utf8"), "lock");
  assert.equal(await exists(join(value.anchor, "Local Storage/old")), false);
  assert.equal(await readFile(join(active.data, "session"), "utf8"), "active");
});

test("backup deletion canonicalizes active roots before checking overlaps", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  const alias = join(value.root, "active-data-alias");
  await put(join(value.roots.data, "sessions/current"), "active conversation");
  await symlink(value.roots.data, alias);
  const active = { data: alias, browser: value.target };
  await assert.rejects(storage.removeBackups([{ data: value.roots.data, browser: value.roots.browser }], active, value.anchor), /active storage/);
  assert.equal(await readFile(join(alias, "sessions/current"), "utf8"), "active conversation");
});

test("backup cleanup validates all roots before deleting any backup", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.data, "sessions/backup"), "preserve backup");
  await put(join(value.target, "active/current"), "active");
  const active = { data: join(value.target, "active"), browser: value.roots.browser };
  await assert.rejects(storage.removeBackups([{ data: value.roots.data, browser: active.browser }], active, value.anchor), /active storage/);
  assert.equal(await readFile(join(value.roots.data, "sessions/backup"), "utf8"), "preserve backup");
});

test("storage preferences round-trip pending work atomically and reject malformed pointers", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  assert.deepEqual(storage.readStoragePreferences(file, value.roots), { version: 1, roots: value.roots, backups: [] });
  const preferences = { version: 1, roots: value.roots, backups: [], pending: { id: randomUUID(), kind: "migrate", target: value.target, language: "en" } };
  storage.writeStoragePreferences(file, preferences);
  assert.deepEqual(storage.readStoragePreferences(file, value.roots), preferences);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await writeFile(file, JSON.stringify({ ...preferences, roots: { data: "relative", browser: value.anchor } }));
  assert.throws(() => storage.readStoragePreferences(file, value.roots), /Invalid storage preferences/);
});

test("setting the path schedules a cold restart, migration switches the pointer only after verification", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); resetHarness(value.anchor);
  await put(join(value.roots.data, "sessions/current"), "conversation");
  await storage.prepareStorage(value.roots.data, false);
  const invoke = registerHandlers(); harness.selection = value.target;
  assert.equal(await invoke("storageChoose"), value.target);
  await invoke("storageMigrate", { path: value.target, language: "en" });
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  const pending = storage.readStoragePreferences(file, value.roots);
  assert.deepEqual(pending.roots, value.roots);
  assert.equal(pending.pending.target, value.target);
  assert.equal(harness.restarts, 1);
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  const complete = storage.readStoragePreferences(file, value.roots);
  assert.deepEqual(complete.roots, { data: join(value.target, "data"), browser: join(value.target, "browser") });
  assert.deepEqual(complete.backups, [value.roots]);
  assert.equal(complete.pending, undefined);
  assert.equal(await readFile(join(complete.roots.data, "sessions/current"), "utf8"), "conversation");
  assert.equal(harness.windows[0].options.webPreferences.partition.startsWith("persist:"), false);
  assert.equal(harness.windows[0].options.webPreferences.nodeIntegration, false);
  assert.ok(harness.windows[0].scripts.some((script) => script.includes(storage.catalogs.en.settings.storage.stages.relocating)));
});

test("pending maintenance redirects Chromium away from the profile being copied", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); resetHarness(value.anchor);
  const leveldb = join(value.roots.browser, "Local Storage/leveldb/LOG");
  await put(leveldb, "leveldb log");
  const id = randomUUID();
  storage.writeStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), {
    version: 1, roots: value.roots, backups: [],
    pending: { id, kind: "migrate", target: value.target, language: "en" },
  });
  // The maintenance window is created at readiness. Chromium initializes its
  // default session there, so the profile must already point elsewhere.
  const ready = harness.app.whenReady;
  t.after(() => { harness.app.whenReady = ready; });
  harness.app.whenReady = async () => {
    const redirected = harness.paths.some(([name, path]) => name === "sessionData" && path !== value.roots.browser && path !== value.anchor);
    if (!redirected) await writeFile(leveldb, "written by the maintenance window session");
  };
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  assert.equal(await readFile(leveldb, "utf8"), "leveldb log");
  assert.deepEqual(harness.paths[0], ["sessionData", join(maintenanceTemp, `pi-desktop-storage-${id}`)]);
});

test("bootstrap refuses missing custom storage without silently creating an empty profile", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); resetHarness(value.anchor);
  const unavailable = { data: join(value.target, "disconnected-data"), browser: join(value.target, "disconnected-browser") };
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(file, { version: 1, roots: unavailable, backups: [] });
  const before = await readFile(file);
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0][0].detail, /unavailable/);
  assert.equal(harness.paths.length, 0);
  assert.equal(await exists(unavailable.data), false);
  assert.equal(await exists(unavailable.browser), false);
  assert.deepEqual(await readFile(file), before);
});

test("failed migration keeps the original pointer and lets the user retry the same destination", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); resetHarness(value.anchor);
  await put(join(value.roots.data, "sessions/current"), "conversation");
  await storage.prepareStorage(value.roots.data, false);
  harness.selection = value.target;
  let invoke = registerHandlers(); await invoke("storageChoose");
  await invoke("storageMigrate", { path: value.target, language: "en" });
  harness.hostError = new Error("interrupted host relocation");
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  const failed = storage.readStoragePreferences(file, value.roots);
  assert.deepEqual(failed.roots, value.roots);
  assert.match(failed.lastError, /interrupted host relocation/);
  assert.equal(harness.errors.length, 1);
  harness.hostError = null;
  await storage.prepareStorage(value.roots.data, false);
  invoke = registerHandlers(); await invoke("storageChoose");
  await invoke("storageMigrate", { path: value.target, language: "en" });
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  assert.equal(storage.readStoragePreferences(file, value.roots).roots.data, join(value.target, "data"));
});

test("IPC refuses untrusted senders, arbitrary paths, duplicate jobs and environment overrides", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); resetHarness(value.anchor);
  await storage.prepareStorage(value.roots.data, false);
  let invoke = registerHandlers();
  await assert.rejects(invoke("storageGet", undefined, "plugin"), /untrusted/);
  await assert.rejects(invoke("storageMigrate", { path: value.target, language: "en" }), /picker/);
  await invoke("storageClearCache", { language: "en" });
  await assert.rejects(invoke("storageClearCache", { language: "en" }), /pending/);
  await storage.prepareStorage(value.roots.data, true);
  invoke = registerHandlers();
  await assert.rejects(invoke("storageChoose"), /PI_DESKTOP_DATA_DIR/);
  await assert.rejects(invoke("storageClearCache", { language: "en" }), /PI_DESKTOP_DATA_DIR/);
});

test("settings cache and backup actions run cold maintenance without changing the active roots", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t); resetHarness(value.anchor);
  const active = { data: join(value.target, "data"), browser: join(value.target, "browser") };
  await put(join(active.data, "cache/temporary"), "temporary");
  await put(join(active.data, "scratch/session/current.md"), "active conversation");
  await put(join(active.browser, "Local Storage/current"), "active browser state");
  await put(join(value.roots.data, "sessions/old"), "backup conversation");
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(file, { version: 1, roots: active, backups: [value.roots] });
  await storage.prepareStorage(value.roots.data, false);
  let invoke = registerHandlers();
  await invoke("storageClearCache", { language: "en" });
  assert.equal(await exists(join(active.data, "cache/temporary")), true);
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  assert.equal(await exists(join(active.data, "cache/temporary")), false);
  let preferences = storage.readStoragePreferences(file, value.roots);
  assert.deepEqual(preferences.roots, active);
  assert.deepEqual(preferences.backups, [value.roots]);
  assert.equal(preferences.pending, undefined);
  await storage.prepareStorage(value.roots.data, false);
  invoke = registerHandlers();
  await invoke("storageRemoveBackup", { language: "en" });
  await assert.rejects(storage.prepareStorage(value.roots.data, false), (error) => error === exitSignal);
  preferences = storage.readStoragePreferences(file, value.roots);
  assert.deepEqual(preferences.roots, active);
  assert.deepEqual(preferences.backups, []);
  assert.equal(await exists(value.roots.data), false);
  assert.equal(await readFile(join(active.data, "scratch/session/current.md"), "utf8"), "active conversation");
  assert.equal(await readFile(join(active.browser, "Local Storage/current"), "utf8"), "active browser state");
  assert.equal(await exists(file), true);
});

async function legacyFixture(t, development = false) {
  const value = await fixture(t);
  const defaultData = join(value.root, development ? ".omp-desktop-dev" : ".omp-desktop");
  const appData = join(value.root, "appData");
  const anchor = join(appData, development ? "OMP-Desktop Dev" : "OMP-Desktop");
  const source = {
    data: join(value.root, development ? ".pi-desktop-dev" : ".pi-desktop"),
    browser: join(appData, development ? "PI-Desktop Dev" : "PI-Desktop"),
  };
  await Promise.all([mkdir(anchor, { recursive: true }), mkdir(source.data), mkdir(source.browser, { recursive: true })]);
  resetHarness(anchor); harness.appData = appData;
  return { ...value, defaultData, appData, anchor, source };
}
const importLegacy = (value, relocate = async () => {}) => storage.importLegacyProfile({
  defaultData: value.defaultData, appData: value.appData, anchor: value.anchor, relocate,
});

for (const development of [false, true]) {
  test(`first ${development ? "development" : "packaged"} start imports durable data without sharing PI roots`, { timeout: 60_000 }, async (t) => {
    const value = await legacyFixture(t, development);
    const files = ["pi.sqlite", "pi.sqlite-wal", "pi.sqlite-shm", "sessions/chat.jsonl", "attachments/blob", "secrets/.machine-key", "plugins/data/demo/config.json"];
    for (const path of files) await put(join(value.source.data, path), `original ${path}`, 0o600);
    await put(join(value.source.browser, "Local Storage/leveldb/data.ldb"), "browser state");
    await put(join(value.source.browser, "SingletonLock"), "upstream lock");
    const before = await Promise.all(files.map((path) => readFile(join(value.source.data, path))));
    const calls = [];
    await importLegacy(value, async (...roots) => calls.push(roots));
    const next = storage.readStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), {});
    assert.deepEqual(next.roots, { data: join(value.defaultData, "data"), browser: join(value.defaultData, "browser") });
    assert.deepEqual(next.backups, [], "PI must never become a deletable OMP backup");
    assert.deepEqual(calls, [[value.source.data, next.roots.data]]);
    for (const [index, path] of files.entries()) {
      assert.deepEqual(await readFile(join(next.roots.data, path)), before[index]);
      assert.deepEqual(await readFile(join(value.source.data, path)), before[index]);
      assert.equal((await lstat(join(value.source.data, path))).mode & 0o777, 0o600);
    }
    assert.equal(await readFile(join(next.roots.browser, "Local Storage/leveldb/data.ldb"), "utf8"), "browser state");
    assert.equal(await exists(join(next.roots.browser, "SingletonLock")), false);
    assert.equal(await readFile(join(value.source.browser, "SingletonLock"), "utf8"), "upstream lock");
    await put(join(next.roots.data, "sessions/chat.jsonl"), "OMP conversation after restart");
    await put(join(value.source.data, "sessions/chat.jsonl"), "new upstream conversation");
    await importLegacy(value, async () => assert.fail("a second startup must not import"));
    await storage.prepareStorage(value.defaultData, false);
    assert.equal(storage.getStorageBootstrap().preferences.roots.data, next.roots.data);
    assert.equal(await readFile(join(next.roots.data, "sessions/chat.jsonl"), "utf8"), "OMP conversation after restart");
  });
}

test("first-start import failure never publishes partial data and retries only its owned job", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "sessions/chat.jsonl"), "original");
  await assert.rejects(importLegacy(value, async () => { throw new Error("offline host failed"); }), /offline host failed/);
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  assert.equal(await exists(file), false);
  harness.hostError = new Error("offline host failed");
  await assert.rejects(storage.prepareStorage(value.defaultData, false), (error) => error === exitSignal);
  assert.equal(await exists(file), false);
  assert.equal(harness.paths.length, 0, "partial data must never be activated");
  assert.equal(await readFile(join(value.source.data, "sessions/chat.jsonl"), "utf8"), "original");
  harness.hostError = null;
  await importLegacy(value);
  assert.equal(await readFile(join(value.defaultData, "data/sessions/chat.jsonl"), "utf8"), "original");
});

test("first-start import refuses unrelated destination bytes and leaves existing OMP profiles alone", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.defaultData, "sessions/omp.jsonl"), "existing OMP data");
  await put(join(value.source.data, "sessions/pi.jsonl"), "upstream data");
  await importLegacy(value, async () => assert.fail("existing OMP data wins"));
  assert.equal(await readFile(join(value.defaultData, "sessions/omp.jsonl"), "utf8"), "existing OMP data");
  assert.equal(await exists(join(value.defaultData, "data")), false);
  assert.equal(await exists(join(value.anchor, "omp-first-start-import.json")), false);
});

test("explicit data and userData profiles opt out of first-start import", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "sessions/pi.jsonl"), "upstream data");
  await storage.prepareStorage(value.defaultData, true);
  assert.equal(await exists(value.defaultData), false);
  assert.equal(storage.getStorageBootstrap().preferences.roots.data, value.defaultData);
  harness.commandSwitches = ["user-data-dir"];
  await storage.prepareStorage(value.defaultData, false);
  assert.equal(await exists(value.defaultData), false);
  assert.equal(await exists(join(value.anchor, "omp-first-start-import.json")), false);
});

test("first-start import uses legacy selected roots but not its pending maintenance or backup ownership", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const selected = { data: value.roots.data, browser: value.roots.browser };
  await put(join(selected.data, "sessions/selected.jsonl"), "selected conversation");
  const file = join(value.source.browser, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(file, { version: 1, roots: selected, backups: [value.source],
    pending: { id: randomUUID(), kind: "cache", language: "en" } });
  const before = await readFile(file);
  await assert.rejects(importLegacy(value), /pending storage maintenance/);
  assert.deepEqual(await readFile(file), before);
  storage.writeStoragePreferences(file, { version: 1, roots: selected, backups: [value.source] });
  await importLegacy(value);
  const next = storage.readStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), {});
  assert.deepEqual(next.backups, []);
  assert.equal(await readFile(join(next.roots.data, "sessions/selected.jsonl"), "utf8"), "selected conversation");
});

test("source-tree changes during import reject before relocation, including newly created WAL files", { timeout: 60_000 }, async (t) => {
  const value = await fixture(t);
  await put(join(value.roots.data, "pi.sqlite"), "original database bytes");
  let changed = false; let relocated = false;
  await assert.rejects(migrate(value, { verifySource: true, progress: (event) => {
    if (event.stage === "verifying" && !changed) {
      changed = true;
      createRequire(import.meta.url)("node:fs").writeFileSync(join(value.roots.data, "pi.sqlite-wal"), "new live WAL");
    }
  }, relocate: async () => { relocated = true; } }), /source profile changed/);
  assert.equal(relocated, false);
  assert.equal(await readFile(join(value.roots.data, "pi.sqlite"), "utf8"), "original database bytes");
});

test("data-only legacy import never creates or writes an upstream browser profile", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await rm(value.source.browser, { recursive: true });
  await put(join(value.source.data, "sessions/chat.jsonl"), "data-only conversation", 0o444);
  await importLegacy(value);
  assert.equal(await exists(value.source.browser), false);
  assert.equal((await lstat(join(value.source.data, "sessions/chat.jsonl"))).mode & 0o777, 0o444);
  assert.equal(await readFile(join(value.defaultData, "data/sessions/chat.jsonl"), "utf8"), "data-only conversation");
});

test("an interrupted import rejects unrelated files without deleting them or activating upstream", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "sessions/chat.jsonl"), "upstream conversation");
  await assert.rejects(importLegacy(value, async () => { throw new Error("interrupted"); }), /interrupted/);
  await put(join(value.defaultData, "unrelated.txt"), "user-owned file");
  await assert.rejects(importLegacy(value), /unrelated data/);
  assert.equal(await readFile(join(value.defaultData, "unrelated.txt"), "utf8"), "user-owned file");
  assert.equal(await exists(join(value.anchor, storage.STORAGE_PREFERENCE_FILE)), false);
  assert.equal(await readFile(join(value.source.data, "sessions/chat.jsonl"), "utf8"), "upstream conversation");
});

test("an existing managed OMP bootstrap owns its pending work and is never replaced by import", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(file, { version: 1, roots: value.roots, backups: [],
    pending: { id: randomUUID(), kind: "cache", language: "en" } });
  const before = await readFile(file);
  await importLegacy(value, async () => assert.fail("existing bootstrap owns maintenance"));
  assert.deepEqual(await readFile(file), before);
  assert.equal(await exists(value.defaultData), false);
});

test("a clean first start records its decision and never imports a later PI profile", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await rm(value.source.data, { recursive: true }); await rm(value.source.browser, { recursive: true });
  await importLegacy(value);
  await put(join(value.source.data, "sessions/later.jsonl"), "later PI installation");
  await importLegacy(value, async () => assert.fail("not a first start"));
  const next = storage.readStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), {});
  assert.deepEqual(next.roots, { data: value.defaultData, browser: value.anchor });
  assert.equal(await exists(join(value.defaultData, "data")), false);
});

test("a default OMP symlink cannot silently reuse the upstream database", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "pi.sqlite"), "upstream database bytes");
  await symlink(value.source.data, value.defaultData, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(importLegacy(value), /private directory/);
  assert.equal(await exists(join(value.anchor, storage.STORAGE_PREFERENCE_FILE)), false);
  assert.equal(await readFile(join(value.source.data, "pi.sqlite"), "utf8"), "upstream database bytes");
});

test("retrying import with an unavailable source cannot publish an empty profile", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "sessions/chat.jsonl"), "saved conversation");
  await assert.rejects(importLegacy(value, async () => { throw new Error("interrupted"); }), /interrupted/);
  await rm(value.source.data, { recursive: true });
  await assert.rejects(importLegacy(value), /source is unavailable/);
  assert.equal(await exists(join(value.anchor, storage.STORAGE_PREFERENCE_FILE)), false);
  assert.equal(await readFile(join(value.defaultData, "data/sessions/chat.jsonl"), "utf8"), "saved conversation");
});

test("managed bootstrap imports before activating any Chromium session and selects only OMP paths", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "sessions/chat.jsonl"), "saved conversation");
  await put(join(value.source.browser, "Local Storage/state"), "saved UI state");
  const bootstrap = await storage.prepareStorage(value.defaultData, false);
  assert.equal(bootstrap.managed, true);
  assert.deepEqual(bootstrap.preferences.roots, { data: join(value.defaultData, "data"), browser: join(value.defaultData, "browser") });
  assert.deepEqual(harness.paths, [["sessionData", bootstrap.preferences.roots.browser]]);
  assert.equal(await readFile(join(bootstrap.preferences.roots.data, "sessions/chat.jsonl"), "utf8"), "saved conversation");
  assert.equal(await readFile(join(bootstrap.preferences.roots.browser, "Local Storage/state"), "utf8"), "saved UI state");
  assert.equal(harness.restarts, 0);
  assert.equal(harness.windows.length, 0);
});

test("unavailable legacy custom storage never falls back to the obsolete upstream default", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.data, "sessions/obsolete.jsonl"), "obsolete upstream default");
  const selected = { data: join(value.root, "disconnected/data"), browser: join(value.root, "disconnected/browser") };
  const file = join(value.source.browser, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(file, { version: 1, roots: selected, backups: [] });
  const before = await readFile(file);
  await assert.rejects(importLegacy(value), /unavailable/);
  assert.deepEqual(await readFile(file), before);
  assert.equal(await exists(value.defaultData), false);
  assert.equal(await exists(join(value.anchor, storage.STORAGE_PREFERENCE_FILE)), false);
});

test("browser-only legacy import never creates an upstream data directory", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await rm(value.source.data, { recursive: true });
  await put(join(value.source.browser, "Local Storage/state"), "saved UI state");
  await importLegacy(value);
  assert.equal(await exists(value.source.data), false);
  assert.equal(await readFile(join(value.defaultData, "browser/Local Storage/state"), "utf8"), "saved UI state");
});

for (const [kind, path] of [["secrets", "secrets"], ["browser", "Local Storage"]]) {
  test(`first-start import rejects shared ${kind} symbolic links before publication`, { timeout: 60_000 }, async (t) => {
    const value = await legacyFixture(t);
    const external = join(value.root, "external-shared-storage");
    await put(join(external, "preserve.txt"), "shared upstream bytes");
    const root = kind === "browser" ? value.source.browser : value.source.data;
    await symlink(external, join(root, path), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(importLegacy(value, async () => assert.fail("unsafe links must not reach relocation")), /symbolic links/);
    assert.equal(await exists(join(value.anchor, storage.STORAGE_PREFERENCE_FILE)), false);
    assert.equal(await readFile(join(external, "preserve.txt"), "utf8"), "shared upstream bytes");
    assert.equal(await realpath(join(root, path)), await realpath(external));
  });
}

for (const existingPreferences of [false, true]) {
  test(`aliased OMP browser anchor is rejected before any source write (${existingPreferences ? "existing pointer" : "new profile"})`, { timeout: 60_000 }, async (t) => {
    const value = await legacyFixture(t);
    if (existingPreferences) storage.writeStoragePreferences(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE), {
      version: 1, roots: value.source, backups: [],
    });
    await put(join(value.source.browser, "source-sentinel"), "original browser bytes");
    const fs = createRequire(import.meta.url)("node:fs");
    const before = fs.readdirSync(value.source.browser).sort();
    const preference = existingPreferences ? await readFile(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE)) : null;
    await rm(value.anchor, { recursive: true });
    await symlink(value.source.browser, value.anchor, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(importLegacy(value), /anchor must be a private directory/);
    await assert.rejects(storage.prepareStorage(value.defaultData, false), (error) => error === exitSignal);
    assert.deepEqual(fs.readdirSync(value.source.browser).sort(), before);
    assert.equal(await readFile(join(value.source.browser, "source-sentinel"), "utf8"), "original browser bytes");
    if (preference) assert.deepEqual(await readFile(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE)), preference);
    assert.equal(await exists(value.defaultData), false);
    assert.equal(harness.paths.length, 0);
  });
}

test("an existing OMP pointer cannot activate upstream SQLite or browser roots", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(file, { version: 1, roots: value.source, backups: [] });
  const before = await readFile(file);
  await assert.rejects(importLegacy(value), /overlaps the PI-Desktop installation/);
  await assert.rejects(storage.prepareStorage(value.defaultData, false), (error) => error === exitSignal);
  assert.deepEqual(await readFile(file), before);
  assert.equal(harness.paths.length, 0);
  assert.equal(await exists(join(value.anchor, "omp-first-start-import.json")), false);
});

test("an OMP anchor nested under upstream storage is rejected before directory creation", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const anchor = join(value.source.browser, "nested-omp-anchor");
  await assert.rejects(storage.importLegacyProfile({ ...value, anchor, relocate: async () => {} }), /overlaps the PI-Desktop installation/);
  assert.equal(await exists(anchor), false);
  assert.equal(await exists(value.defaultData), false);
  assert.equal(await exists(join(value.source.browser, "omp-first-start-import.json")), false);
});

test("existing OMP pointers are checked against legacy custom roots before activation", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const selected = { data: value.roots.data, browser: value.roots.browser };
  storage.writeStoragePreferences(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE), { version: 1, roots: selected, backups: [] });
  storage.writeStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), { version: 1, roots: selected, backups: [] });
  await assert.rejects(importLegacy(value), /overlaps the PI-Desktop installation/);
  assert.equal(await exists(join(value.anchor, "omp-first-start-import.json")), false);
});

for (const profile of ["private-data", "private-pointer", "imported"]) {
  test(`established OMP ${profile} starts with malformed upstream preferences`, { timeout: 60_000 }, async (t) => {
    const value = await legacyFixture(t);
    let active = { data: value.defaultData, browser: value.anchor };
    if (profile === "imported") {
      await put(join(value.source.data, "sessions/chat.jsonl"), "original imported conversation");
      await importLegacy(value);
      active = storage.readStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), {}).roots;
    } else if (profile === "private-pointer") {
      active = value.roots;
      storage.writeStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), { version: 1, roots: active, backups: [] });
    }
    await put(join(active.data, "sessions/chat.jsonl"), "OMP conversation must survive");
    await put(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE), "{broken JSON");
    const bootstrap = await storage.prepareStorage(value.defaultData, false);
    assert.deepEqual(bootstrap.preferences.roots, active);
    assert.equal(await readFile(join(active.data, "sessions/chat.jsonl"), "utf8"), "OMP conversation must survive");
    assert.deepEqual(harness.paths, [["sessionData", active.browser]]);
    assert.equal(harness.errors.length, 0);
  });
}

test("a genuine first-start import still refuses malformed upstream preferences", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await put(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE), "{broken JSON");
  await assert.rejects(importLegacy(value), SyntaxError);
  assert.equal(await exists(value.defaultData), false);
  assert.equal(await exists(join(value.anchor, "omp-first-start-import.json")), false);
  assert.equal(await exists(join(value.anchor, storage.STORAGE_PREFERENCE_FILE)), false);
});

test("a completed import journal rejects its original custom source even when upstream preferences break", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const selected = value.roots;
  const sourcePreference = join(value.source.browser, storage.STORAGE_PREFERENCE_FILE);
  storage.writeStoragePreferences(sourcePreference, { version: 1, roots: selected, backups: [] });
  await put(join(selected.data, "sessions/chat.jsonl"), "upstream custom conversation");
  await importLegacy(value);
  await put(sourcePreference, "{broken upstream JSON");
  storage.writeStoragePreferences(join(value.anchor, storage.STORAGE_PREFERENCE_FILE), { version: 1, roots: selected, backups: [] });
  await assert.rejects(importLegacy(value), /overlaps the PI-Desktop installation/);
  assert.equal(await readFile(join(selected.data, "sessions/chat.jsonl"), "utf8"), "upstream custom conversation");
});

test("damaged current OMP preferences are never swallowed with damaged upstream preferences", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  const file = join(value.anchor, storage.STORAGE_PREFERENCE_FILE);
  await put(file, "{broken OMP JSON");
  await put(join(value.source.browser, storage.STORAGE_PREFERENCE_FILE), "{broken upstream JSON");
  await assert.rejects(importLegacy(value), SyntaxError);
  assert.equal(await readFile(file, "utf8"), "{broken OMP JSON");
  assert.equal(await exists(value.defaultData), false);
});

test("data-only completed import journal retains its private browser on restart", { timeout: 60_000 }, async (t) => {
  const value = await legacyFixture(t);
  await rm(value.source.browser, { recursive: true });
  await put(join(value.source.data, "sessions/chat.jsonl"), "source conversation");
  await importLegacy(value);
  await put(join(value.defaultData, "data/sessions/chat.jsonl"), "OMP conversation");
  const bootstrap = await storage.prepareStorage(value.defaultData, false);
  assert.deepEqual(bootstrap.preferences.roots, { data: join(value.defaultData, "data"), browser: join(value.defaultData, "browser") });
  assert.equal(await readFile(join(bootstrap.preferences.roots.data, "sessions/chat.jsonl"), "utf8"), "OMP conversation");
  assert.equal(await exists(value.source.browser), false);
});
