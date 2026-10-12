import "../omp/omp.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { Input, SettingsToggle } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { ompThemeSyncEnabled, setOmpThemeSync } from "../omp/OmpThemeSync";
import { parsePreferenceCount, saveOmpPreference, subscribeOmpConfig } from "../omp/preferences";
import { OMP_THEME_EVENT, OMP_THEME_STORAGE_KEY } from "../omp/OmpThemeSync";
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
      { key: "spelling.autocomplete", kind: "select", options: ["off", "auto", "ngram", "smollm", "apple"] },
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
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [themes, setThemes] = useState<string[]>([]);
  const [sync, setSync] = useState(ompThemeSyncEnabled());
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refreshSequence = useRef(0);
  const mounted = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const fail = (e: unknown) => {
      if (mounted.current) showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    };
    const refresh = () => {
      const sequence = ++refreshSequence.current;
      void api.ompConfigGet().then((result) => {
        if (mounted.current && sequence === refreshSequence.current) setValues(result.values);
      }).catch(fail);
    };
    const updateSync = () => setSync(ompThemeSyncEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === OMP_THEME_STORAGE_KEY || event.key === null) updateSync();
    };
    refresh();
    void api.ompThemes().then((result) => {
      if (mounted.current) setThemes(result.names);
    }).catch(fail);
    const stop = subscribeOmpConfig(api, refresh);
    window.addEventListener(OMP_THEME_EVENT, updateSync);
    window.addEventListener("storage", onStorage);
    return () => {
      mounted.current = false;
      ++refreshSequence.current;
      stop();
      window.removeEventListener(OMP_THEME_EVENT, updateSync);
      window.removeEventListener("storage", onStorage);
    };
  }, [showToast]);

  const save = async (key: string, value: unknown) => {
    if (saving.current) return;
    saving.current = true;
    ++refreshSequence.current;
    setBusy(true);
    try {
      const next = await saveOmpPreference(api, key, value);
      ++refreshSequence.current;
      if (mounted.current) setValues(next);
      if (key === "providers.cacheWarming" && activeSessionId?.startsWith("native-pi:")) {
        const result = await api.ompSessionCommand<{ mode: string }>(activeSessionId, {
          type: "set_cache_warming", mode: next[key],
        });
        if (mounted.current) showToast(t("settings.ompPrefs.cacheApplied", {
          mode: t(`settings.ompPrefs.options.${result.mode}`),
        }));
      }
    } catch (e) {
      if (mounted.current) showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const disabled = busy || values === null;
  const renderField = (field: Field) => {
    const value = values?.[field.key];
    if (field.kind === "bool") {
      return (
        <SettingsToggle
          label={t(fieldKey(field.key))}
          checked={value === true}
          disabled={disabled}
          busy={busy}
          onChange={() => void save(field.key, value !== true)}
        />
      );
    }
    if (field.kind === "select") {
      return (
        <SettingsMenuSelect
          label={t(fieldKey(field.key))}
          value={String(value ?? "")}
          disabled={disabled}
          busy={busy}
          onChange={(option) => void save(field.key, option)}
          options={field.options.map((option) => ({
            id: option,
            label: t(`settings.ompPrefs.options.${option}`),
            disabled: option === "apple" && window.piDesktop?.platform !== "darwin",
          }))}
        />
      );
    }
    const draft = drafts[field.key] ?? (value === undefined ? "" : String(value));
    return (
      <Input
        type="number"
        min={0}
        step={1}
        aria-label={t(fieldKey(field.key))}
        className="omp-pref-number"
        data-omp-pref={field.key}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDrafts((d) => ({ ...d, [field.key]: e.target.value }))}
        onBlur={() => {
          const parsed = parsePreferenceCount(draft);
          if (parsed === null || parsed === value) {
            setDrafts(({ [field.key]: _, ...rest }) => rest);
            return;
          }
          void save(field.key, parsed).then(() => setDrafts(({ [field.key]: _, ...rest }) => rest));
        }}
      />
    );
  };

  const themeSelect = (key: "theme.dark" | "theme.light") => (
    <SettingsMenuSelect
      label={t(fieldKey(key))}
      value={String(values?.[key] ?? "")}
      disabled={disabled || themes.length === 0}
      busy={busy}
      onChange={(name) => void save(key, name)}
      options={themes.map((name) => ({ id: name, label: name }))}
    />
  );

  return (
    <div data-omp-prefs="true">
      <SettingsCard title={t("settings.ompPrefs.appearance")} description={t("settings.ompPrefs.appearanceDesc")}>
        <SettingsRow title={t(fieldKey("theme.dark"))}>{themeSelect("theme.dark")}</SettingsRow>
        <SettingsRow title={t(fieldKey("theme.light"))}>{themeSelect("theme.light")}</SettingsRow>
        <SettingsRow title={t("settings.ompPrefs.syncAccent")} description={t("settings.ompPrefs.syncAccentDesc")}>
          <SettingsToggle
            label={t("settings.ompPrefs.syncAccent")}
            checked={sync}
            onChange={() => setOmpThemeSync(!sync)}
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
            <SettingsRow key={field.key} title={t(fieldKey(field.key))} description={
              field.key === "composer.predictions" ? t("settings.ompPrefs.predictionUsage") :
              field.key === "spelling.autocomplete" ? t("settings.ompPrefs.wordUsage") : field.key
            }>
              {renderField(field)}
            </SettingsRow>
          ))}
        </SettingsCard>
      ))}
    </div>
  );
}
