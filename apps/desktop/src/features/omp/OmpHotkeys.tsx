import type { KeyboardShortcutId } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";

/**
 * Keyboard shortcuts that mirror omp's TUI defaults (pi-tui DEFAULT_ACTION_KEYS).
 * The rebindable ones live in the app's shortcut registry (Settings → Keyboard
 * shortcuts) and run through `runOmpShortcut`:
 *   Shift+Tab  app.thinking.cycle      – next thinking level (composer focused)
 *   Ctrl+P / Ctrl+Shift+P app.model.cycleForward / cycleBackward
 *   Alt+M      app.model.select        – open the model picker
 *   F5         app.retry               – retry the last failed turn (/retry)
 *   Escape     app.interrupt           – stop a running turn outside overlays
 */
const OMP_SHORTCUTS: Partial<Record<KeyboardShortcutId, true>> = { ompCycleThinking: true, ompCycleModel: true, ompCycleModelBackward: true, ompSelectModel: true, ompRetry: true, ompInterrupt: true };
const OVERLAY = '[role="dialog"], .composer-autocomplete, .composer-menu-root, .composer-model-list, [role="menu"]';

export function isOmpShortcut(id: KeyboardShortcutId): boolean {
  return OMP_SHORTCUTS[id] === true;
}

function overlayOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(OVERLAY)).some((el) => el.getClientRects().length > 0);
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
export function runOmpShortcut(id: KeyboardShortcutId, target: EventTarget | null, event?: KeyboardEvent): boolean {
  if (event && (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat)) return false;
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
    case "ompCycleModelBackward":
      if (!modelPicker || modelPicker.disabled) return false;
      void pickNext('[data-omp-model-picker="true"]', "[data-omp-model]", id === "ompCycleModelBackward" ? -1 : 1);
      return true;
    case "ompSelectModel":
      if (!modelPicker || modelPicker.disabled) return false;
      modelPicker.click();
      return true;
    case "ompRetry": {
      if (target instanceof HTMLElement && target.closest(".settings-page")) return false;
      const state = useAppStore.getState();
      if (!modelPicker || state.isRunning || !state.activeSessionId) return false;
      void state.sendPrompt("/retry", undefined, state.activeSessionId);
      return true;
    }
    case "ompInterrupt": {
      const state = useAppStore.getState();
      if (!modelPicker || !state.activeSessionId || !state.isRunning) return false;
      void state.abort();
      return true;
    }
    default:
      return false;
  }
}

