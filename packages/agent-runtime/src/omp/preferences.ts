import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OmpModelRef = { provider: string; modelId: string };
export type OmpPreferences = { model?: OmpModelRef; thinkingLevel?: string; hiddenFiles?: string[] };

/** App-owned preferences (never omp's own config): last chosen model and thinking level. */
export function ompPreferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_DESKTOP_OMP_PREFS?.trim()) return env.PI_DESKTOP_OMP_PREFS.trim();
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "omp-desktop", "preferences.json");
}

export function readOmpPreferences(path = ompPreferencesPath()): OmpPreferences {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const prefs: OmpPreferences = {};
    if (value?.model && typeof value.model.provider === "string" && typeof value.model.modelId === "string") {
      prefs.model = { provider: value.model.provider, modelId: value.model.modelId };
    }
    if (typeof value?.thinkingLevel === "string") prefs.thinkingLevel = value.thinkingLevel;
    if (Array.isArray(value?.hiddenFiles)) prefs.hiddenFiles = value.hiddenFiles.filter((entry: unknown) => typeof entry === "string");
    return prefs;
  } catch {
    return {};
  }
}

export function writeOmpPreferences(prefs: OmpPreferences, path = ompPreferencesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** `PI_DESKTOP_OMP_MODEL=provider/model` overrides the remembered choice. */
export function envModelOverride(env: NodeJS.ProcessEnv = process.env): OmpModelRef | undefined {
  const value = env.PI_DESKTOP_OMP_MODEL?.trim();
  if (!value) return undefined;
  const slash = value.indexOf("/");
  return slash > 0 ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } : undefined;
}
