import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


test("the built-in window palette is declared once", async () => {
  const builtinTheme = await readFile(
    new URL("../../../packages/shared/src/theme.ts", import.meta.url),
    "utf8",
  );
  assert.match(builtinTheme, /windowBackground: "#ffffff"/);
  assert.match(builtinTheme, /windowBackground: "#181818"/);
  for (const relative of [
    "../electron/main/bootstrap/window.ts",
    "../electron/main/plugin-panel-host.ts",
    "../electron/main/ipc/window-ipc.ts",
    "../electron/preload/plugin-panel.ts",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /builtinWindowBackground/);
    // The dark plate is the distinctive half of the pair; the panel preload
    // still names #ffffff as page ink, which the theme table does not own.
    assert.doesNotMatch(source, /#181818/);
  }
});
