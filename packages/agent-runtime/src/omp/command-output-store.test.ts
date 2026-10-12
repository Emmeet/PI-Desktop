import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { listOmpCommandSessions, mergeOmpCommandOutputs, readOmpCommandOutputs, recordOmpCommandOutput, recordOmpCommandSession } from "./command-output-store.js";
import { parseOmpSession } from "./session-store.js";

const msg = (id: string, role: UiMessage["role"] = "user"): UiMessage => ({ id, role, content: id, createdAt: "2026-10-12T00:00:00Z", status: "complete" });

describe("omp command output store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stores outputs and splices them after their anchor", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-cmd-"));
    dirs.push(dir);
    recordOmpCommandOutput("s1", { id: "a", anchor: "m1", command: "/session", output: "info", createdAt: "t" }, dir);
    recordOmpCommandOutput("s1", { id: "b", anchor: "", command: "/usage", output: "u", createdAt: "t" }, dir);
    recordOmpCommandOutput("s1", { id: "c", anchor: "gone", command: "/x", output: "x", createdAt: "t" }, dir);
    recordOmpCommandOutput("s1", { id: "d", anchor: "m1", command: "/login", output: "secret", createdAt: "t" }, dir);
    expect(() => recordOmpCommandOutput("../evil", { id: "e", anchor: "", command: "/x", output: "x", createdAt: "t" }, dir)).toThrow("Invalid command-output session id");
    const records = readOmpCommandOutputs("s1", dir);
    expect(records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    const merged = mergeOmpCommandOutputs([msg("m1"), msg("m2", "assistant")], records);
    expect(merged.map((m) => m.id)).toEqual([
      "omp-command-in:b",
      "omp-command:b",
      "m1",
      "omp-command-in:a",
      "omp-command:a",
      "m2",
    ]);
    expect(merged[4]?.content).toContain("info");
    expect(readOmpCommandOutputs("../evil", dir)).toEqual([]);
  });

  it("groups multi-frame invocation input, deduplicates records, and reuses persisted user messages", () => {
    const records = [
      { id: "one", invocationId: "invocation", anchor: "u", command: "/usage", output: "first", createdAt: "t", userEntryId: "u" },
      { id: "two", invocationId: "invocation", anchor: "u", command: "/usage", output: "second", createdAt: "t", userEntryId: "u" },
    ];
    const merged = mergeOmpCommandOutputs([{ ...msg("u"), content: "/usage" }, msg("a", "assistant")], [...records, records[0]!]);
    expect(merged.map((message) => message.id)).toEqual(["u", "omp-command:one", "omp-command:two", "a"]);
    const local = records.map((record) => ({ ...record, anchor: "", userEntryId: undefined }));
    expect(mergeOmpCommandOutputs([], local).map((message) => message.id)).toEqual(["omp-command-in:invocation", "omp-command:one", "omp-command:two"]);
  });

  it("anchors output to non-message branch entries instead of leaking through a shared ancestor", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-branches-")); dirs.push(dir);
    const path = join(dir, "branch.jsonl");
    const header = { type: "session", id: "branch-session", cwd: dir, timestamp: "2026-10-12T00:00:00Z" };
    const entries = [header,
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "shared" } },
      { type: "thinking_level_change", id: "left", parentId: "u", thinkingLevel: "high" },
      { type: "message", id: "left-a", parentId: "left", message: { role: "assistant", content: "left" } },
    ];
    recordOmpCommandOutput("branch-session", { id: "output", anchor: "left", command: "/session", output: "left output", createdAt: "t" }, dir);
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const previous = process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR;
    process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR = dir;
    try {
      expect(parseOmpSession(path)?.messages.map((message) => message.id)).toEqual(["u", "omp-command-in:output", "omp-command:output", "left-a"]);
      appendFileSync(path, "\n" + JSON.stringify({ type: "message", id: "right-a", parentId: "u", message: { role: "assistant", content: "right" } }));
      expect(parseOmpSession(path)?.messages.map((message) => message.id)).toEqual(["u", "right-a"]);
    } finally {
      if (previous === undefined) delete process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR;
      else process.env.PI_DESKTOP_OMP_COMMAND_OUTPUT_DIR = previous;
    }
  });

  it("never stores or rehydrates private commands, even from legacy rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-private-")); dirs.push(dir);
    for (const command of ["/login github", "/logout", "/auth token", "/config", "/env", "/secret"]) {
      recordOmpCommandOutput("private", { id: command, anchor: "", command, output: "TOKEN", createdAt: "t" }, dir);
    }
    expect(existsSync(join(dir, "private.jsonl"))).toBe(false);
    appendFileSync(join(dir, "legacy.jsonl"), JSON.stringify({ id: "private", anchor: "", command: "/login", output: "TOKEN", createdAt: "t" }) + "\n");
    expect(readOmpCommandOutputs("legacy", dir)).toEqual([]);
  });

  it("persists empty-session identity atomically and exposes filesystem write failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-manifest-")); dirs.push(dir);
    const session = { sessionId: "empty", sessionPath: join(dir, "future.jsonl"), cwd: dir, createdAt: "t" };
    recordOmpCommandOutput("empty", { id: "out", anchor: "", command: "/session", output: "info", createdAt: "t" }, dir);
    recordOmpCommandSession(session, dir);
    expect(listOmpCommandSessions(dir)).toEqual([session]);
    expect(readFileSync(join(dir, "empty.jsonl"), "utf8")).toContain("info");
    const blocked = join(dir, "blocked"); writeFileSync(blocked, "not a directory");
    expect(() => recordOmpCommandOutput("empty", { id: "bad", anchor: "", command: "/session", output: "lost", createdAt: "t" }, blocked)).toThrow();
  });

  it("keeps the next output readable after a torn prior append", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-torn-")); dirs.push(dir);
    writeFileSync(join(dir, "torn.jsonl"), '{"id":"incomplete"');
    recordOmpCommandOutput("torn", { id: "complete", anchor: "", command: "/session", output: "Recovered", createdAt: "t" }, dir);
    expect(readOmpCommandOutputs("torn", dir).map((record) => record.id)).toEqual(["complete"]);
  });
});
