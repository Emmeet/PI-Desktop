import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { RENDERER_HOST_KEY, rendererHostModuleSources, rendererImportMapSource, publishRendererHostModules } = await import(
  "../src/plugins/renderer-host/import-map.ts"
);

test("plugin imports share host React hooks, context and DOM roots", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, RENDERER_HOST_KEY);
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, RENDERER_HOST_KEY, previous);
    else delete globalThis[RENDERER_HOST_KEY];
  });
  publishRendererHostModules();
  const sources = rendererHostModuleSources();
  const { imports } = JSON.parse(rendererImportMapSource());
  const imported = {};
  for (const specifier of ["react", "react-dom", "react-dom/client"]) {
    const source = sources[imports[specifier].replace(/^\.\//, "")];
    imported[specifier] = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  }
  assert.equal(imported.react.useState, React.useState);
  assert.equal(imported.react.createContext, React.createContext);
  assert.equal(imported.react.Fragment, React.Fragment);
  assert.equal(imported["react-dom"].createPortal, ReactDom.createPortal);
  assert.equal(imported["react-dom/client"].createRoot, ReactDomClient.createRoot);
  assert.equal(imported["react-dom/client"].hydrateRoot, ReactDomClient.hydrateRoot);
});
