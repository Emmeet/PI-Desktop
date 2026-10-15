import { useEffect } from "react";
import type { KeyboardShortcutId } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";

/**
 * Keyboard shortcuts that mirror omp's TUI defaults (pi-tui DEFAULT_ACTION_KEYS).
 * The rebindable ones live in the app's shortcut registry (Settings → Keyboard
 * shortcuts) and run through `runOmpShortcut`:
 *   Shift+Tab  app.thinking.cycle      – next thinking level (composer focused)
 *   Mod+P      app.model.cycleForward  – next model in the picker
 *   Alt+M      app.model.select        – open the model picker
 *   F5         app.retry               – retry the last failed turn (/retry)
 * Esc (app.interrupt) is handled by <OmpHotkeys/>: it stops the running turn
 * when no menu or dialog would take the key first.
 */
const OMP_SHORTCUTS = new Set<KeyboardShortcutId>(["ompCycleThinking", "ompCycleModel", "ompSelectModel", "ompRetry"]);
const OVERLAY = '[role="dialog"], .composer-autocomplete, .composer-menu-root, .composer-model-list, [role="menu"]';

export function isOmpShortcut(id: KeyboardShortcutId): boolean {
  return OMP_SHORTCUTS.has(id);
}

function overlayOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(OVERLAY)).some((el) => el.offsetParent !== null);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function pickNext(triggerSelector: string, itemSelector: string, step: number): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(triggerSelector);
  if (!trigger || trigger.disabled) return;
  trigger.click();
  await nextFrame();
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(itemSelector));
  if (items.length === 0) {
    trigger.click();
    return;
  }
  const current = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
  items[(current + step + items.length) % items.length]?.click();
}

/** Runs one omp shortcut; false when it does not apply here (the key keeps its normal meaning). */
export function runOmpShortcut(id: KeyboardShortcutId, target: EventTarget | null): boolean {
  if (overlayOpen()) return false;
  const modelPicker = document.querySelector<HTMLButtonElement>('[data-omp-model-picker="true"]');
  switch (id) {
    case "ompCycleThinking": {
      const inComposer = target instanceof HTMLElement && Boolean(target.closest(".composer-stack, .composer"));
      if (!inComposer || !document.querySelector('[data-omp-thinking-picker="true"]')) return false;
      void pickNext('[data-omp-thinking-picker="true"]', "[data-omp-thinking]", 1);
      return true;
    }
    case "ompCycleModel":
      if (!modelPicker) return false;
      void pickNext('[data-omp-model-picker="true"]', "[data-omp-model]", 1);
      return true;
    case "ompSelectModel":
      if (!modelPicker || modelPicker.disabled) return false;
      modelPicker.click();
      return true;
    case "ompRetry": {
      const state = useAppStore.getState();
      if (!modelPicker || state.isRunning || !state.activeSessionId) return false;
      void state.sendPrompt("/retry", undefined, state.activeSessionId);
      return true;
    }
    default:
      return false;
  }
}

/** Esc stops the running turn, like omp's app.interrupt. */
export function OmpHotkeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const state = useAppStore.getState();
      if (!state.isRunning || overlayOpen()) return;
      event.preventDefault();
      void state.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
