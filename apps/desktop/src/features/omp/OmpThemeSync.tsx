import { useEffect } from "react";
import { api } from "../../lib/api";
import { subscribeOmpConfig } from "./preferences";
import { OmpAccentSync } from "./theme-sync";

export const OMP_THEME_STORAGE_KEY = "omp.themeAccentSync";
export const OMP_THEME_EVENT = "omp-theme-sync-changed";

export function ompThemeSyncEnabled(): boolean {
  try {
    return localStorage.getItem(OMP_THEME_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOmpThemeSync(enabled: boolean): void {
  try {
    localStorage.setItem(OMP_THEME_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(OMP_THEME_EVENT));
}


/**
 * Optional theme sync: the app's accent follows the omp TUI theme chosen for
 * the current mode (`theme.dark` / `theme.light` in omp's config).
 */
export function OmpThemeSync() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = new OmpAccentSync(root, (color) => CSS.supports("color", color));
    const refresh = () => {
      void sync.refresh(ompThemeSyncEnabled(), async () => {
        const [config, themes] = await Promise.all([api.ompConfigGet(), api.ompThemes()]);
        return { values: config.values, palettes: themes.palettes };
      });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === OMP_THEME_STORAGE_KEY || event.key === null) refresh();
    };
    window.addEventListener(OMP_THEME_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    const stop = subscribeOmpConfig(api, refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    refresh();
    return () => {
      stop();
      window.removeEventListener(OMP_THEME_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
      observer.disconnect();
      sync.restore();
    };
  }, []);
  return null;
}
