import type { OmpValues } from "./preferences";

const ACCENT_TOKENS = ["--ds-accent", "--ds-accent-hover", "--ds-accent-soft", "--ds-focus"] as const;

type ThemeRoot = {
  style: Pick<CSSStyleDeclaration, "getPropertyValue" | "getPropertyPriority" | "setProperty" | "removeProperty">;
  dataset: { theme?: string; ompTheme?: string };
};

/** Owns only accent semantics, never the app's surface/text or theme-mode tokens. */
export class OmpAccentSync {
  private generation = 0;
  private original: { values: Array<{ key: string; value: string; priority: string }>; name?: string } | null = null;

  private readonly root: ThemeRoot;
  private readonly validColor: (value: string) => boolean;

  constructor(root: ThemeRoot, validColor: (value: string) => boolean) {
    this.root = root;
    this.validColor = validColor;
  }

  restore(): void {
    ++this.generation;
    if (!this.original) return;
    for (const { key, value, priority } of this.original.values) {
      if (value) this.root.style.setProperty(key, value, priority);
      else this.root.style.removeProperty(key);
    }
    if (this.original.name === undefined) delete this.root.dataset.ompTheme;
    else this.root.dataset.ompTheme = this.original.name;
    this.original = null;
  }

  async refresh(enabled: boolean, load: () => Promise<{ values: OmpValues; palettes: Record<string, Record<string, string>> }>): Promise<void> {
    this.restore();
    if (!enabled) return;
    const generation = this.generation;
    const mode = this.root.dataset.theme === "light" ? "light" : "dark";
    try {
      const { values, palettes } = await load();
      if (generation !== this.generation || mode !== (this.root.dataset.theme === "light" ? "light" : "dark")) return;
      const name = values[`theme.${mode}`];
      if (typeof name !== "string") return;
      const palette = palettes[name];
      const accent = palette?.accent;
      if (!accent || !this.validColor(accent)) return;
      const hover = palette.borderAccent && this.validColor(palette.borderAccent) ? palette.borderAccent : accent;
      this.original = {
        values: ACCENT_TOKENS.map((key) => ({ key, value: this.root.style.getPropertyValue(key), priority: this.root.style.getPropertyPriority(key) })),
        name: this.root.dataset.ompTheme,
      };
      this.root.style.setProperty("--ds-accent", accent);
      this.root.style.setProperty("--ds-accent-hover", hover);
      this.root.style.setProperty("--ds-accent-soft", `color-mix(in srgb, ${accent} 65%, transparent)`);
      this.root.style.setProperty("--ds-focus", accent);
      this.root.dataset.ompTheme = name;
    } catch {
      // Restoration happened before the request; a stale failure cannot erase a newer theme.
    }
  }
}
