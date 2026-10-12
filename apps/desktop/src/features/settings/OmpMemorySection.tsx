import "../omp/omp.css";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";

const BACKENDS = ["off", "local", "hindsight", "mnemopi", "sharpshooter"] as const;

/** omp memory: which backend serves recall/retain, and whether past chats are mined for memories. */
export function OmpMemorySection() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.ompConfigGet().then((result) => setValues(result.values)).catch((e) => showToast(String(e?.message ?? e), { variant: "error" }));
  }, [showToast]);

  const save = async (key: string, value: unknown) => {
    setBusy(true);
    try {
      await api.ompConfigSet(key, value);
      setValues((current) => ({ ...(current ?? {}), [key]: value }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const backend = String(values?.["memory.backend"] ?? "");
  return (
    <div data-omp-memory="true">
      <SettingsCard title={t("settings.ompMemory.title")} description={t("settings.ompMemory.description")}>
        <SettingsRow title={t("settings.ompMemory.backend")} description={t("settings.ompMemory.backendDesc")}>
          <select
            className="settings-select"
            data-omp-memory-backend="true"
            value={backend}
            disabled={busy || values === null}
            onChange={(e) => void save("memory.backend", e.target.value)}
          >
            {values === null ? <option value="">…</option> : null}
            {BACKENDS.map((value) => (
              <option key={value} value={value}>{t(`settings.ompMemory.backends.${value}`)}</option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow title={t("settings.ompMemory.enabled")} description={t("settings.ompMemory.enabledDesc")}>
          <input
            type="checkbox"
            data-omp-memory-enabled="true"
            checked={values?.["memories.enabled"] === true}
            disabled={busy || values === null}
            onChange={(e) => void save("memories.enabled", e.target.checked)}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
