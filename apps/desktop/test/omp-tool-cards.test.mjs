import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { buildToolPresentation, parseOmpDiff, isOmpMemoryTool } = await import("../src/lib/tool-presentation.ts");
const { getToolSummary } = await import("../src/lib/tool-display.ts");

test("omp edit results render their hashline diff with a revert handle", () => {
  const blocks = buildToolPresentation({
    toolName: "edit",
    toolArgs: { input: "[/tmp/x/t.txt#93C8]\nPUT 1.=1:\n+beta" },
    toolResult: {
      content: [{ type: "text", text: "ok" }],
      details: { diff: "-1|alpha\n+1|beta", op: "update", path: "/tmp/x/t.txt", oldText: "alpha\n", newText: "beta\n" },
    },
  });
  const diff = blocks.find((block) => block.kind === "diff");
  assert.ok(diff, "diff block");
  assert.deepEqual(diff.revert, { path: "/tmp/x/t.txt", oldText: "alpha\n", newText: "beta\n" });
  assert.equal(parseOmpDiff("-1|alpha\n+1|beta").length, 2);
  assert.equal(getToolSummary("edit", { input: "[/tmp/x/t.txt#93C8]\nPUT 1.=1:\n+beta" }), "/tmp/x/t.txt");
});

test("omp memory tools and image results render as cards", () => {
  assert.equal(isOmpMemoryTool("recall"), true);
  const memory = buildToolPresentation({
    toolName: "recall",
    toolArgs: { query: "favorite color" },
    toolResult: { content: [{ type: "text", text: "**blue**" }], details: {} },
  });
  assert.ok(JSON.stringify(memory).includes("blue"));
  const shot = buildToolPresentation({
    toolName: "browser",
    toolArgs: { action: "screenshot" },
    toolResult: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], details: { ok: true } },
  });
  const images = shot.find((block) => block.kind === "images");
  assert.ok(images, "images block");
  assert.equal(images.images[0].mimeType, "image/png");
});
