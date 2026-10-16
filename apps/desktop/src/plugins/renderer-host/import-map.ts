/**
 * The one React the host renderer and every plugin renderer module share.
 *
 * A plugin that brought its own React would break hooks and context in the
 * first component that mixed the two. A build-generated, CSP-hashed import
 * map resolves `react`, `react-dom` and `react-dom/client` to static shims
 * over the live host namespaces published here.
 *
 * The shims are generated from the live namespaces rather than a hand-written
 * list, so a hook the host can use is a hook a plugin can import; there is no
 * second surface to keep in step.
 */
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as React from "react";

/** Where the generated shims read their modules from. Not a plugin API. */
export const RENDERER_HOST_KEY = "__PI_RENDERER_HOST__";

type RendererHostModules = {
  react: typeof React;
  reactDom: typeof ReactDom;
  reactDomClient: typeof ReactDomClient;
};

export const REACT_IMPORT_MAP: Readonly<Record<string, keyof RendererHostModules>> = {
  react: "react",
  "react-dom": "reactDom",
  "react-dom/client": "reactDomClient",
};

const modules: RendererHostModules = { react: React, reactDom: ReactDom, reactDomClient: ReactDomClient };

/**
 * A module that re-exports the host's namespace. One `export const x = host.x`
 * per key is what makes this work without a bundler: a bare `export *` has
 * nothing to point at, because the host's copy lives in a closure, not at a URL.
 */
function shimSource(key: keyof RendererHostModules, namespace: Record<string, unknown>): string {
  const lines = [`const host = globalThis.${RENDERER_HOST_KEY}[${JSON.stringify(key)}];`];
  if ("default" in namespace) lines.push("export default host.default;");
  for (const name of Object.keys(namespace)) {
    if (name === "default") continue;
    // Only legal binding names; React's namespace has nothing else, and a key
    // that is not one would fail the whole module rather than quietly vanish.
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    lines.push(`export const ${name} = host[${JSON.stringify(name)}];`);
  }
  return lines.join("\n");
}

/** Static sources emitted by Vite, never evaluated from inline or blob script. */
export function rendererHostModuleSources(): Record<string, string> {
  return Object.fromEntries(Object.values(REACT_IMPORT_MAP).map((key) => [
    `renderer-host/${key}.js`, shimSource(key, modules[key] as unknown as Record<string, unknown>),
  ]));
}

/** Exact import-map bytes hashed by the build's Content Security Policy. */
export function rendererImportMapSource(): string {
  return JSON.stringify({ imports: Object.fromEntries(
    Object.entries(REACT_IMPORT_MAP).map(([specifier, key]) => [specifier, `./renderer-host/${key}.js`]),
  ) });
}

/** Publish before loading a plugin so every shim shares the host's React. */
export function publishRendererHostModules(): void {
  (globalThis as Record<string, unknown>)[RENDERER_HOST_KEY] = modules;
}
