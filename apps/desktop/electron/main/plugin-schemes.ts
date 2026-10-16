import { protocol } from "electron";
import { PLUGIN_ASSET_SCHEME_PRIVILEGES } from "./plugin-asset-protocol";
import { PLUGIN_RENDERER_SCHEME_PRIVILEGES } from "./plugin-renderer-protocol";

/**
 * Reserve every host-owned plugin scheme before the app is ready.
 *
 * Electron accepts `registerSchemesAsPrivileged` once per process: a second
 * call replaces the secure/fetch/CORS scheme lists that child processes
 * inherit, so the renderer would quietly lose the privileges of whichever
 * scheme registered first. Each protocol module owns its privileges; this is
 * the one place that registers them, together.
 */
let registered = false;

export function registerPluginSchemes(): void {
  // entry.ts registers synchronously before async storage preparation (which
  // may let Electron become ready); the composition root call is then a no-op.
  if (registered) return;
  registered = true;
  protocol.registerSchemesAsPrivileged([
    PLUGIN_ASSET_SCHEME_PRIVILEGES,
    PLUGIN_RENDERER_SCHEME_PRIVILEGES,
  ]);
}
