import "../omp/omp.css";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { ompThemeSyncEnabled, setOmpThemeSync } from "../omp/OmpThemeSync";
import { SettingsCard, SettingsRow } from "./primitives";

type Field =
  | { key: string; kind: "bool" }
  | { key: string; kind: "select"; options: readonly string[] }
  | { key: string; kind: "count" };

const SECTIONS: Array<{ id: string; fields: Field[] }> = [
  {
    id: "input",
    fields: [
      { key: "composer.predictions", kind: "bool" },
      { key: "spelling.autocomplete", kind: "select", options: ["off", "auto", "ngram", "smollm"] },
    ],
  },
  {
    id: "providers",
    fields: [
      { key: "providers.cacheWarming", kind: "select", options: ["off", "streaming", "idle"] },
      { key: "providers.anthropic.slowMode", kind: "select", options: ["off", "auto"] },
    ],
  },
  {
    id: "lsp",
    fields: [
      { key: "lsp.enabled", kind: "bool" },
      { key: "lsp.lazy", kind: "bool" },
      { key: "lsp.shared", kind: "bool" },
      { key: "lsp.formatOnWrite", kind: "bool" },
      { key: "lsp.diagnosticsOnWrite", kind: "bool" },
      { key: "lsp.diagnosticsOnEdit", kind: "bool" },
      { key: "lsp.diagnosticsDeduplicate", kind: "bool" },
    ],
  },
  { id: "git", fields: [{ key: "git.enabled", kind: "bool" }] },
  {
    id: "commit",
    fields: [
      { key: "commit.mapReduceEnabled", kind: "bool" },
      { key: "commit.mapReduceThreshold", kind: "count" },
      { key: "commit.mapBatchTokenBudget", kind: "count" },
      { key: "commit.cacheEnabled", kind: "bool" },
      { key: "commit.cacheTtlDays", kind: "count" },
      { key: "commit.changelogMaxDiffChars", kind: "count" },
    ],
  },
];

/** Label key for an omp setting: dots become underscores so i18next does not nest them. */
const fieldKey = (key: string) => `settings.ompPrefs.fields.${key.replace(/\./g, "_")}`;

/** omp preferences: theme, input, providers, LSP, git and commit settings from omp's config. */
export function OmpPreferencesPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [themes, setThemes] = useState<string[]>([]);
  const [sync, setSync] = useState(ompThemeSyncEnabled());
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    api.ompConfigGet().then((result) => setValues(result.values)).catch(fail);
    api.ompThemes().then((result) => setThemes(result.names)).catch(fail);
  }, [showToast]);

  const save = async (key: string, value: unknown) => {
    setBusy(true);
    try {
      await api.ompConfigSet(key, value);
      setValues((current) => ({ ...(current ?? {}), [key]: value }));
      if (key.startsWith("theme.") && sync) setOmpThemeSync(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || values === null;
  const renderField = (field: Field) => {
    const value = values?.[field.key];
    if (field.kind === "bool") {
      return (
        <input
          type="checkbox"
          data-omp-pref={field.key}
          checked={value === true}
          disabled={disabled}
          onChange={(e) => void save(field.key, e.target.checked)}
        />
      );
    }
    if (field.kind === "select") {
      return (
        <select
          className="settings-select"
          data-omp-pref={field.key}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => void save(field.key, e.target.value)}
        >
          {values === null ? <option value="">…</option> : null}
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      );
    }
    const draft = drafts[field.key] ?? (value === undefined ? "" : String(value));
    return (
      <input
        type="number"
        min={0}
        className="settings-input omp-pref-number"
        data-omp-pref={field.key}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDrafts((d) => ({ ...d, [field.key]: e.target.value }))}
        onBlur={() => {
          const parsed = Number(draft);
          if (draft === String(value ?? "") || !Number.isInteger(parsed) || parsed < 0) {
            setDrafts(({ [field.key]: _, ...rest }) => rest);
            return;
          }
          void save(field.key, parsed).then(() => setDrafts(({ [field.key]: _, ...rest }) => rest));
        }}
      />
    );
  };

  const themeSelect = (key: "theme.dark" | "theme.light") => (
    <select
      className="settings-select"
      data-omp-pref={key}
      value={String(values?.[key] ?? "")}
      disabled={disabled || themes.length === 0}
      onChange={(e) => void save(key, e.target.value)}
    >
      {values === null || themes.length === 0 ? <option value="">…</option> : null}
      {themes.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  );

  return (
    <div data-omp-prefs="true">
      <SettingsCard title={t("settings.ompPrefs.appearance")} description={t("settings.ompPrefs.appearanceDesc")}>
        <SettingsRow title={t(fieldKey("theme.dark"))}>{themeSelect("theme.dark")}</SettingsRow>
        <SettingsRow title={t(fieldKey("theme.light"))}>{themeSelect("theme.light")}</SettingsRow>
        <SettingsRow title={t("settings.ompPrefs.syncAccent")} description={t("settings.ompPrefs.syncAccentDesc")}>
          <input
            type="checkbox"
            data-omp-pref="themeSync"
            checked={sync}
            onChange={(e) => {
              setSync(e.target.checked);
              setOmpThemeSync(e.target.checked);
            }}
          />
        </SettingsRow>
        <SettingsRow title={t(fieldKey("symbolPreset"))}>
          {renderField({ key: "symbolPreset", kind: "select", options: ["unicode", "nerd", "ascii"] })}
        </SettingsRow>
      </SettingsCard>
      {SECTIONS.map((section) => (
        <SettingsCard
          key={section.id}
          title={t(`settings.ompPrefs.sections.${section.id}`)}
          description={t(`settings.ompPrefs.sections.${section.id}Desc`)}
        >
          {section.fields.map((field) => (
            <SettingsRow key={field.key} title={t(fieldKey(field.key))} description={field.key}>
              {renderField(field)}
            </SettingsRow>
          ))}
        </SettingsCard>
      ))}
    </div>
  );
}
