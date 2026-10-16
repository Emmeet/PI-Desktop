import { app, BrowserWindow } from "electron";
import { registerPluginSchemes } from "./plugin-schemes";
import { defaultDataDir, hasSingleInstanceLock, singleInstanceRequired } from "./installation";
import { prepareStorage } from "./storage/bootstrap";

// Do not top-level-await Electron readiness: module evaluation gates the ready event.
// The full composition root is imported only after offline maintenance has finished.
if (hasSingleInstanceLock) {
  // Scheme privileges are only accepted before `ready`; storage preparation
  // (legacy import) is async, so reserve them now.
  registerPluginSchemes();
  let booted = false;
  app.on("second-instance", () => {
    if (booted) return;
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  void prepareStorage(defaultDataDir, !singleInstanceRequired)
    .then(() => {
      booted = true;
      return import("./index");
    })
    .catch((error: unknown) => {
      console.error("Storage startup failed", error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
}
