import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "../../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
export const rendererProbeUnavailable = process.platform === "linux" && !process.env.DISPLAY
  ? "Isolated Electron renderer requires a display"
  : false;

/** Production renderer modules in a fresh sandboxed Electron profile; only IPC is a fixture. */
export async function runOmpRendererProbe(source, probe = "ompP2Probe", screenshotPath) {
  const temp = await mkdtemp(join(tmpdir(), "omp-p2-renderer-"));
  try {
    await build({
      stdin: { contents: source, resolveDir: root, sourcefile: join(root, "omp-p2-probe.tsx"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [{ name: "url-assets", setup(b) {
        b.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: "url-asset" }));
        b.onLoad({ filter: /.*/, namespace: "url-asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
      } }],
    });
    const renderer = join(root, "apps/desktop/out/renderer");
    const html = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((m) => m[1]);
    assert(css.length, "Build the production renderer before UI probes");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(join(temp, "index.html"), `<!doctype html><html data-platform="linux" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((p) => `<link rel="stylesheet" href="${p}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript(${JSON.stringify(`window.${probe}()`)});
    ${screenshotPath ? `await fs.writeFile(${JSON.stringify(screenshotPath)}, (await win.webContents.capturePage()).toPNG());` : ""}
    console.log("OMP_P2_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const line = output.split(/\r?\n/).find((value) => value.startsWith("OMP_P2_PROBE "));
    assert(line, output);
    return JSON.parse(line.slice("OMP_P2_PROBE ".length));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
