import { useEffect, useState } from "react";
import { api } from "../../lib/api";

const STORAGE_KEY = "omp.themeAccentSync";
export const OMP_THEME_EVENT = "omp-theme-sync-changed";

export function ompThemeSyncEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOmpThemeSync(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(OMP_THEME_EVENT));
}

function currentMode(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Optional theme sync: the app's accent follows the omp TUI theme chosen for
 * the current mode (`theme.dark` / `theme.light` in omp's config).
 */
export function OmpThemeSync() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    window.addEventListener(OMP_THEME_EVENT, bump);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      window.removeEventListener(OMP_THEME_EVENT, bump);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty("--ds-accent");
      root.style.removeProperty("--ds-accent-hover");
      delete root.dataset.ompTheme;
    };
    if (!ompThemeSyncEnabled()) {
      clear();
      return;
    }
    let live = true;
    void Promise.all([api.ompConfigGet(), api.ompThemes()])
      .then(([config, themes]) => {
        if (!live) return;
        const mode = currentMode();
        const name = String(config.values[mode === "light" ? "theme.light" : "theme.dark"] ?? "");
        const accent = themes.palettes[name]?.accent;
        if (!accent) return clear();
        root.style.setProperty("--ds-accent", accent);
        root.style.setProperty("--ds-accent-hover", themes.palettes[name]?.borderAccent ?? accent);
        root.dataset.ompTheme = name;
      })
      .catch(clear);
    return () => {
      live = false;
    };
  }, [tick]);
  return null;
}
