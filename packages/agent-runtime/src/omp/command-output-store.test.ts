import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { mergeOmpCommandOutputs, readOmpCommandOutputs, recordOmpCommandOutput } from "./command-output-store.js";

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
    recordOmpCommandOutput("../evil", { id: "e", anchor: "", command: "/x", output: "x", createdAt: "t" }, dir);
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
});
