import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WordPredictionRequests, wordPredictionEligible, wordSuggestionMatches, acceptWordSuggestion } = await import("../src/features/omp/word-prediction.ts");
const input = { sessionId: "native-pi:test", text: "hel", cursor: 3, composing: false, blocked: false, method: "ngram" };

function tab(overrides = {}) {
  return {
    key: "Tab", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    isComposing: false, defaultPrevented: false, repeat: false, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
    ...overrides,
  };
}

test("IME, slash commands, @files, disabled engines and stale caret are ineligible", () => {
  assert.equal(wordPredictionEligible(input), true);
  for (const patch of [
    { composing: true }, { blocked: true }, { method: "off" }, { cursor: 2 },
    { text: "/hello", cursor: 6 }, { text: "  /hello", cursor: 8 },
    { text: "open @hello", cursor: 11 },
  ]) assert.equal(wordPredictionEligible({ ...input, ...patch }), false);
});

test("late responses are discarded after a new request, invalidation, or backend selection change", async () => {
  const requests = new WordPredictionRequests();
  let resolve;
  const old = requests.request(input, () => new Promise((done) => { resolve = done; }));
  const nextInput = { ...input, text: "hell", cursor: 4 };
  const next = await requests.request(nextInput, async () => ({ suffix: "o" }));
  resolve({ suffix: "p" });
  assert.equal(await old, null);
  assert.equal(next.suffix, "o");
  assert.equal(wordSuggestionMatches(next, nextInput), true);
  assert.equal(wordSuggestionMatches(next, { ...nextInput, method: "smollm" }), false);
  assert.equal(wordSuggestionMatches(next, { ...nextInput, sessionId: "native-pi:other" }), false);
  const pending = requests.request(input, () => new Promise((done) => { resolve = done; }));
  requests.invalidate();
  resolve({ suffix: "lo" });
  assert.equal(await pending, null);
});

test("Tab accepts through the draft helper and consumes the key only on success", () => {
  const suggestion = { input, suffix: "lo" };
  let draft = input.text;
  let insertions = 0;
  const event = tab();
  const insert = (suffix) => { ++insertions; draft += suffix; return true; };
  assert.equal(acceptWordSuggestion(event, suggestion, input, false, insert), true);
  assert.equal(draft, "hello");
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(acceptWordSuggestion(tab(), suggestion, { ...input, text: draft, cursor: draft.length }, false, insert), false);
  assert.equal(insertions, 1);
  for (const patch of [{ isComposing: true }, { defaultPrevented: true }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }]) {
    assert.equal(acceptWordSuggestion(tab(patch), suggestion, input, false, insert), false);
  }
  assert.equal(acceptWordSuggestion(tab(), suggestion, input, true, insert), false);
  const failed = tab();
  assert.equal(acceptWordSuggestion(failed, suggestion, input, false, () => false), false);
  assert.equal(failed.prevented, false);
});
