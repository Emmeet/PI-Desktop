import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { BtwActions, GoalActions, runHandoff } = await import("../src/features/omp/session-actions.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const topic = { id: "topic-1", question: "Original?", answer: "Original answer", status: "complete" };
const event = (method, sessionId, frame) => ({ method, params: { sessionId, frame } });

test("BTW loads persisted history and streams a correlated follow-up without duplicate sends", async () => {
  const request = deferred();
  const calls = [];
  const actions = new BtwActions("native-pi:a", async (sessionId, command) => {
    calls.push({ sessionId, command });
    return command.type === "get_btw_history" ? { records: [topic] } : request.promise;
  });
  await actions.load();
  assert.equal(actions.getSnapshot().selectedId, topic.id);
  const asking = actions.ask(" Follow up? ");
  assert.equal(await actions.ask("duplicate"), false);
  assert.deepEqual(calls[1], { sessionId: "native-pi:a", command: { type: "btw", question: "Follow up?", recordId: topic.id } });
  actions.event(event("native.btw", "native-pi:a", { type: "btw_record", record: topic }));
  actions.event(event("native.btw", "native-pi:a", { type: "btw_delta", recordId: topic.id, delta: "not this turn" }));
  assert.ok(actions.getSnapshot().pending);
  assert.equal(actions.getSnapshot().records[0].answer, topic.answer);
  const running = { ...topic, followUps: [{ question: "Follow up?", answer: "", status: "running" }] };
  actions.event(event("native.btw", "native-pi:b", { type: "btw_record", record: running }));
  assert.ok(actions.getSnapshot().pending);
  actions.event(event("native.btw", "native-pi:a", { type: "btw_record", record: running }));
  actions.event(event("native.btw", "native-pi:a", { type: "btw_delta", recordId: "wrong", delta: "wrong" }));
  actions.event(event("native.btw", "native-pi:a", { type: "btw_delta", recordId: topic.id, delta: "Streamed" }));
  assert.equal(actions.getSnapshot().records[0].followUps[0].answer, "Streamed");
  const complete = { ...topic, followUps: [{ question: "Follow up?", answer: "Streamed answer", status: "complete" }] };
  request.resolve({ record: complete });
  assert.equal(await asking, true);
  assert.equal(actions.getSnapshot().busy, false);
  assert.equal(actions.getSnapshot().records[0].followUps[0].answer, "Streamed answer");
  actions.dispose();
});

test("BTW new topic records stream ID, cancels exactly once, and ignores late completion after close/session switch", async () => {
  const request = deferred();
  const cancellation = deferred();
  const calls = [];
  const actions = new BtwActions("native-pi:old", async (sessionId, command) => {
    calls.push({ sessionId, command });
    if (command.type === "get_btw_history") return { records: [topic] };
    return command.type === "btw_cancel" ? cancellation.promise : request.promise;
  });
  await actions.load();
  actions.select();
  const asking = actions.ask("New question");
  const running = { id: "fresh-topic", question: "New question", answer: "partial", status: "running" };
  actions.event(event("native.btw", "native-pi:old", { type: "btw_record", record: running }));
  const cancel = actions.cancel();
  await actions.cancel();
  assert.equal(await actions.ask("while cancelling"), false);
  actions.dispose();
  assert.deepEqual(calls.filter(({ command }) => command.type === "btw_cancel"), [{ sessionId: "native-pi:old", command: { type: "btw_cancel", recordId: "fresh-topic" } }]);
  const frozen = actions.getSnapshot();
  request.resolve({ record: { ...running, answer: "late", status: "complete" } });
  cancellation.resolve({ cancelled: true });
  await cancel;
  assert.equal(await asking, false);
  actions.event(event("native.btw", "native-pi:old", { type: "btw_record", record: { ...running, answer: "later" } }));
  assert.equal(actions.getSnapshot(), frozen);
  const next = new BtwActions("native-pi:new", async () => ({ records: [] }));
  await next.load();
  assert.deepEqual(next.getSnapshot().records, []);
  next.dispose();
});

test("BTW closes before a stream ID is known by cancelling only its owning session", async () => {
  const pending = deferred();
  const calls = [];
  const actions = new BtwActions("native-pi:own", async (sessionId, command) => {
    calls.push({ sessionId, command });
    if (command.type === "get_btw_history") return { records: [] };
    if (command.type === "btw_cancel") return { cancelled: true };
    return pending.promise;
  });
  await actions.load();
  const asking = actions.ask("Question");
  actions.dispose();
  assert.deepEqual(calls.at(-1), { sessionId: "native-pi:own", command: { type: "btw_cancel" } });
  pending.resolve({ record: { ...topic, question: "Question" } });
  assert.equal(await asking, false);
});

test("BTW failures release busy state and preserve completed history", async () => {
  const actions = new BtwActions("native-pi:a", async (_, command) => {
    if (command.type === "get_btw_history") return { records: [topic] };
    throw new Error("provider rejected");
  });
  await actions.load();
  assert.equal(await actions.ask("fail"), false);
  assert.equal(actions.getSnapshot().busy, false);
  assert.equal(actions.getSnapshot().pending, undefined);
  assert.deepEqual(actions.getSnapshot().records, [topic]);
  assert.match(actions.getSnapshot().error.message, /provider rejected/);
  actions.dispose();
});

test("a side answer finishing before cancellation remains complete instead of claiming cancellation", async () => {
  const request = deferred();
  const complete = { ...topic, followUps: [{ question: "Follow up", answer: "Finished already", status: "complete" }] };
  let reads = 0;
  const actions = new BtwActions("native-pi:a", async (_, command) => {
    if (command.type === "get_btw_history") return { records: [++reads === 1 ? topic : complete] };
    if (command.type === "btw_cancel") return { cancelled: false };
    return request.promise;
  });
  await actions.load();
  const asking = actions.ask("Follow up");
  actions.event(event("native.btw", "native-pi:a", { type: "btw_record", record: { ...topic, followUps: [{ question: "Follow up", answer: "partial", status: "running" }] } }));
  await actions.cancel();
  assert.deepEqual(actions.getSnapshot().records, [complete]);
  assert.equal(actions.getSnapshot().busy, false);
  request.resolve({ record: complete });
  assert.equal(await asking, false);
  actions.dispose();
});

test("failed BTW cancellation preserves ownership, streaming and a safe retry", async () => {
  const request = deferred();
  let cancellationAttempts = 0;
  const actions = new BtwActions("native-pi:a", async (_, command) => {
    if (command.type === "get_btw_history") return { records: [] };
    if (command.type === "btw_cancel") {
      if (++cancellationAttempts === 1) throw new Error("cancel failed");
      return { cancelled: true };
    }
    return request.promise;
  });
  await actions.load();
  const asking = actions.ask("Question");
  const running = { ...topic, question: "Question", answer: "", status: "running" };
  actions.event(event("native.btw", "native-pi:a", { type: "btw_record", record: running }));
  await actions.cancel();
  assert.equal(actions.getSnapshot().busy, true);
  assert.equal(await actions.ask("another question"), false);
  assert.match(actions.getSnapshot().error.message, /cancel failed/);
  actions.event(event("native.btw", "native-pi:a", { type: "btw_delta", recordId: topic.id, delta: "still streaming" }));
  assert.equal(actions.getSnapshot().records[0].answer, "still streaming");
  await actions.cancel();
  assert.equal(actions.getSnapshot().busy, false);
  assert.equal(actions.getSnapshot().records[0].status, "cancelled");
  assert.equal(actions.getSnapshot().error, null);
  request.resolve({ record: { ...running, status: "cancelled" } });
  assert.equal(await asking, false);
  actions.dispose();
});

test("goal get/create/pause/resume/drop use engine operations and token_budget", async () => {
  let goal = null;
  const calls = [];
  const actions = new GoalActions("native-pi:g", async (sessionId, command) => {
    calls.push({ sessionId, command });
    if (command.op === "create") goal = { objective: command.objective, status: "active", tokensUsed: 0, tokenBudget: command.token_budget };
    if (command.op === "pause") goal = { ...goal, status: "paused" };
    if (command.op === "resume") goal = { ...goal, status: "active" };
    if (command.op === "drop") goal = null;
    return { goal, state: goal ? { goal, enabled: true } : null };
  });
  await actions.run("get");
  assert.equal(actions.getSnapshot().goal, null);
  await actions.run("create", { objective: "Finish", token_budget: 100 });
  assert.equal(actions.getSnapshot().goal.tokenBudget, 100);
  await actions.run("pause");
  assert.equal(actions.getSnapshot().goal.status, "paused");
  await actions.run("resume");
  assert.equal(actions.getSnapshot().goal.status, "active");
  await actions.run("drop");
  assert.equal(actions.getSnapshot().goal, null);
  assert.deepEqual(calls.map(({ command }) => command.op), ["get", "create", "pause", "resume", "drop"]);
  assert.deepEqual(calls[1], { sessionId: "native-pi:g", command: { type: "goal", op: "create", objective: "Finish", token_budget: 100 } });
  actions.dispose();
});

test("live goal update beats an older get result; duplicate actions and disposed-session replies are ignored", async () => {
  const request = deferred();
  let calls = 0;
  const actions = new GoalActions("native-pi:a", async () => { calls++; return request.promise; });
  const get = actions.run("get");
  await actions.run("drop");
  assert.equal(calls, 1);
  const live = { objective: "Live", status: "paused", tokensUsed: 20 };
  actions.event(event("native.goal", "native-pi:b", { type: "goal_updated", goal: live }));
  assert.equal(actions.getSnapshot().goal, undefined);
  actions.event(event("native.goal", "native-pi:a", { type: "goal_updated", goal: live }));
  request.resolve({ goal: null, state: null });
  await get;
  assert.deepEqual(actions.getSnapshot().goal, live);
  actions.dispose();
  const frozen = actions.getSnapshot();
  actions.event(event("native.goal", "native-pi:a", { type: "goal_updated", goal: null }));
  assert.equal(actions.getSnapshot(), frozen);
});

test("failed initial goal get stays unknown and can recover without showing a false create form", async () => {
  let fail = true;
  const actions = new GoalActions("native-pi:a", async () => {
    if (fail) throw new Error("offline");
    return { goal: null, state: null };
  });
  await actions.run("get");
  assert.equal(actions.getSnapshot().goal, undefined);
  assert.equal(actions.getSnapshot().busy, false);
  fail = false;
  await actions.run("get");
  assert.equal(actions.getSnapshot().goal, null);
  assert.equal(actions.getSnapshot().error, null);
  actions.dispose();
});

test("closing a goal panel isolates late RPC completion from the next session", async () => {
  const request = deferred();
  const old = new GoalActions("native-pi:old", async () => request.promise);
  const loading = old.run("get");
  old.dispose();
  const frozen = old.getSnapshot();
  const next = new GoalActions("native-pi:next", async () => ({ goal: null, state: null }));
  await next.run("get");
  request.resolve({ goal: { objective: "Old session", status: "active", tokensUsed: 0 }, state: {} });
  await loading;
  assert.equal(old.getSnapshot(), frozen);
  assert.equal(next.getSnapshot().goal, null);
  next.dispose();
});

test("handoff waits actual compaction result, refreshes same session, and never reports cancelled/stale operations successful", async () => {
  const request = deferred();
  const calls = [];
  let current = true;
  const input = {
    sessionId: "native-pi:own", instructions: "  Keep details  ", failureMessage: "No result",
    command: async (sessionId, command) => { calls.push({ sessionId, command }); return request.promise; },
    isCurrent: () => current,
    refreshSessions: async () => { calls.push("refresh"); },
    selectSession: async (id) => { calls.push(["select", id]); },
  };
  const handing = runHandoff(input);
  assert.equal(calls.length, 1);
  request.resolve({});
  assert.equal(await handing, "completed");
  assert.deepEqual(calls, [{ sessionId: "native-pi:own", command: { type: "handoff", customInstructions: "Keep details" } }, "refresh", ["select", "native-pi:own"]]);
  calls.length = 0;
  assert.equal(await runHandoff({ ...input, command: async () => null }), "cancelled");
  assert.equal(calls.length, 0);
  current = false;
  assert.equal(await runHandoff(input), "stale");
  assert.equal(calls.length, 1);
  current = true;
  await assert.rejects(runHandoff({ ...input, command: async () => undefined }), /No result/);
  calls.length = 0;
  assert.equal(await runHandoff({ ...input, refreshSessions: async () => { current = false; } }), "stale");
  assert.equal(calls.length, 1);
});
