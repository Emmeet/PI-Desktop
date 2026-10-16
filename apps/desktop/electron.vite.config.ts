import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { rendererHostModuleSources, rendererImportMapSource } from "./src/plugins/renderer-host/import-map";

// Static shared-React modules let production reject inline/eval/blob scripts.
function rendererSecurity(): Plugin {
  const map = rendererImportMapSource();
  const hash = createHash("sha256").update(map).digest("base64");
  const sources = rendererHostModuleSources();
  return {
    name: "omp-renderer-security",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0]?.replace(/^\//, "");
        if (!path || !Object.hasOwn(sources, path)) return next();
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(sources[path]);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(sources)) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        // React Refresh injects a preamble only in development. Production has
        // one allowed inline script: this exact immutable import map.
        const devUrl = context.server?.resolvedUrls?.local[0];
        let result = html.replace("script-src 'self' plugin-renderer:;",
          `script-src 'self' plugin-renderer: ${devUrl ? "'unsafe-inline'" : `'sha256-${hash}'`};`);
        if (devUrl) {
          const origin = new URL(devUrl).origin;
          const websocket = origin.replace(/^http/, "ws");
          result = result.replace("connect-src 'self' plugin-renderer:;",
            `connect-src 'self' plugin-renderer: ${origin} ${websocket};`);
        }
        return result.replace("</head>", `<script type="importmap">${map}</script></head>`);
      },
    },
  };
}

// Electron 43 ships a Chromium that always supports woff2, but KaTeX's
// stylesheet lists woff and truetype fallbacks for every face. Dropping those
// src entries lets Rollup tree-shake ~0.8 MB of .woff/.ttf assets it would
// otherwise emit but never serve.
function dropLegacyFontFallbacks(): Plugin {
  return {
    name: "pi-drop-legacy-font-fallbacks",
    apply: "build",
    // Must run before Vite rewrites url() into asset references, otherwise the
    // .woff/.ttf files are already registered for emission.
    enforce: "pre",
    transform(code, id) {
      if (!/\.css(?:\?.*)?$/.test(id)) return null;
      const stripped = code.replace(
        /,\s*url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  main: {
    // `ws` loads its optional native accelerators (bufferutil, utf-8-validate)
    // inside `require` + try/catch and falls back to its own JavaScript
    // implementation when they are absent. A bundle cannot fail a require, and
    // Vite turns the unresolved optional peer into a module-level throw that
    // kills the whole Main bundle before the app starts, so state the documented
    // "no native accelerator" input to that branch at build time instead.
    define: {
      "process.env.WS_NO_BUFFER_UTIL": "\"1\"",
      "process.env.WS_NO_UTF_8_VALIDATE": "\"1\"",
      // The main bundle is ESM (`type: module`), where Node does not provide
      // the CommonJS `__dirname` global used by Electron's relative asset paths.
      "__dirname": "import.meta.dirname",
    },
    build: {
      rollupOptions: {
        // Bundle JS workspace packages into Main. Native voice modules must
        // resolve from packaged node_modules because their loaders locate
        // platform libraries relative to their own package directories.
        // jiti is loaded lazily by the sidecar's trusted-extension loader
        // (D387); Electron main never calls it, and its transpiled dist
        // breaks the main bundle's esbuild transform.
        external: [
          "electron-updater",
          "jiti",
          "jiti/static",
          "@picovoice/pvrecorder-node",
          "transcribe-cpp",
        ],
        input: {
          index: resolve(__dirname, "electron/main/entry.ts"),
          // Forked per plugin by PluginRuntime (ADR 0008); must stay a
          // standalone entry so utilityProcess can point at a real file.
          "plugin-host-process": resolve(__dirname, "electron/main/plugin-host-process.mjs"),
        },
      },
    },
  },
  preload: {
    // The preload must be a fully bundled CJS file so it can run in a
    // sandboxed renderer without Node module resolution.
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload/index.ts"),
          "plugin-panel": resolve(__dirname, "electron/preload/plugin-panel.ts"),
        },
        output: {
          format: "cjs",
          // Main window preload stays .cjs; plugin panels use .js as referenced by panel host.
          entryFileNames: (chunk) =>
            chunk.name === "plugin-panel" ? "[name].js" : "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      // electron-vite's renderer preset hard-defaults minify to false, unlike
      // plain Vite. Enabling esbuild minification roughly halves the emitted
      // renderer chunks with no behavior change.
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
        },
      },
    },
    plugins: [react(), tailwindcss(), rendererSecurity(), dropLegacyFontFallbacks()],
    resolve: {
      alias: [
        { find: "@renderer", replacement: resolve("src") },
        {
          find: /^@pi-desktop\/i18n\/locales\/([^/]+)$/,
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locales/$1/index.ts",
          ),
        },
        {
          find: "@pi-desktop/i18n/locale-info",
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locale-info.ts",
          ),
        },
        // Always read locale source so new keys work without a stale packages/*/dist.
        {
          find: "@pi-desktop/i18n",
          replacement: resolve(__dirname, "../../packages/i18n/src/index.ts"),
        },
      ],
    },
  },
});
