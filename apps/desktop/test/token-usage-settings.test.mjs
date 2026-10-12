import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

test("settings usage destination is omp's own stats page; host token history stays available", () => {
  assert.match(search, /id: "usage"/);
  assert.match(search, /settings\.nav\.usage/);
  assert.doesNotMatch(settingsPage, /TokenUsagePage/);
  assert.match(settingsPage, /OmpUsagePage/);
  assert.match(api, /getTokenUsageHistory/);
});

test("settings usage page component is gone", async () => {
  await assert.rejects(
    () =>
      access(
        new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
        constants.F_OK,
      ),
    { code: "ENOENT" },
  );
});
