import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { saveOmpPreference, parsePreferenceCount, subscribeOmpConfig } = await import("../src/features/omp/preferences.ts");
const { OmpAccentSync } = await import("../src/features/omp/theme-sync.ts");

function rootFixture() {
  const properties = new Map([["--ds-accent", { value: "#123456", priority: "important" }]]);
  return {
    dataset: { theme: "dark" },
    style: {
      getPropertyValue: (key) => properties.get(key)?.value ?? "",
      getPropertyPriority: (key) => properties.get(key)?.priority ?? "",
      setProperty: (key, value, priority = "") => properties.set(key, { value, priority }),
      removeProperty: (key) => properties.delete(key),
    },
  };
}

const palettes = { titanium: { accent: "#ff8800", borderAccent: "#ffaa00" }, light: { accent: "#334455" } };

test("settings writes read normalized values back before applying dark/light accents", async () => {
  let values = { "theme.dark": "titanium", "theme.light": "light", "providers.cacheWarming": "idle" };
  const calls = [];
  const api = {
    async ompConfigSet(key, value) {
      calls.push("write");
      // A persisted engine value, not an optimistic echo of a submitted alias.
      values = { ...values, [key]: value === "DARK" ? "titanium" : value };
      return { ok: true };
    },
    async ompConfigGet() { calls.push("read"); return { values: { ...values } }; },
  };
  const readback = await saveOmpPreference(api, "theme.dark", "DARK");
  assert.deepEqual(calls, ["write", "read"]);
  assert.equal(readback["theme.dark"], "titanium");
  const root = rootFixture();
  const sync = new OmpAccentSync(root, (value) => /^#[a-f\d]{6}$/i.test(value));
  await sync.refresh(true, async () => ({ values: readback, palettes }));
  assert.equal(root.dataset.ompTheme, "titanium");
  assert.equal(root.style.getPropertyValue("--ds-accent"), "#ff8800");
  assert.equal(root.style.getPropertyValue("--ds-focus"), "#ff8800");
  assert.equal(root.style.getPropertyValue("--ds-bg-primary"), "");
  root.dataset.theme = "light";
  await sync.refresh(true, async () => ({ values: readback, palettes }));
  assert.equal(root.dataset.ompTheme, "light");
  assert.equal(root.style.getPropertyValue("--ds-accent"), "#334455");
  await sync.refresh(false, async () => { throw Error("must not read while disabled"); });
  assert.equal(root.style.getPropertyValue("--ds-accent"), "#123456");
  assert.equal(root.style.getPropertyPriority("--ds-accent"), "important");
  assert.equal(root.style.getPropertyValue("--ds-focus"), "");
  assert.equal(root.dataset.ompTheme, undefined);
});

test("theme mode changes and disable invalidate late success and late errors", async () => {
  const root = rootFixture();
  const sync = new OmpAccentSync(root, () => true);
  let resolveDark;
  const dark = sync.refresh(true, () => new Promise((resolve) => { resolveDark = resolve; }));
  root.dataset.theme = "light";
  await sync.refresh(true, async () => ({ values: { "theme.light": "light" }, palettes }));
  resolveDark({ values: { "theme.dark": "titanium" }, palettes });
  await dark;
  assert.equal(root.dataset.ompTheme, "light");
  let reject;
  const failure = sync.refresh(true, () => new Promise((_, fail) => { reject = fail; }));
  await sync.refresh(true, async () => ({ values: { "theme.light": "light" }, palettes }));
  reject(Error("old request"));
  await failure;
  assert.equal(root.dataset.ompTheme, "light");
  let resolve;
  const pending = sync.refresh(true, () => new Promise((done) => { resolve = done; }));
  sync.restore();
  resolve({ values: { "theme.light": "light" }, palettes });
  await pending;
  assert.equal(root.style.getPropertyValue("--ds-accent"), "#123456");
});

test("invalid palette leaves application accents untouched", async () => {
  const root = rootFixture();
  const sync = new OmpAccentSync(root, () => false);
  await sync.refresh(true, async () => ({ values: { "theme.dark": "titanium" }, palettes }));
  assert.equal(root.style.getPropertyValue("--ds-accent"), "#123456");
  assert.equal(root.dataset.ompTheme, undefined);
});

test("config broadcast and focus refresh without a permanently cached promise", () => {
  const previous = globalThis.window;
  const window = new EventTarget();
  globalThis.window = window;
  let listener;
  let stopped = false;
  let reads = 0;
  try {
    const unsubscribe = subscribeOmpConfig({ onOmpEvent(callback) { listener = callback; return () => { stopped = true; }; } }, () => { ++reads; });
    listener({ method: "omp.config.changed" });
    listener({ method: "omp.other" });
    window.dispatchEvent(new Event("focus"));
    assert.equal(reads, 2);
    unsubscribe();
    assert.equal(stopped, true);
    window.dispatchEvent(new Event("focus"));
    assert.equal(reads, 2);
  } finally { globalThis.window = previous; }
});

test("numeric drafts do not persist empty, fractional, negative, or unsafe counts", () => {
  for (const draft of ["", " ", "1.5", "-1", "Infinity", "9007199254740992"]) assert.equal(parsePreferenceCount(draft), null);
  assert.equal(parsePreferenceCount("0"), 0);
  assert.equal(parsePreferenceCount("16000"), 16000);
});
