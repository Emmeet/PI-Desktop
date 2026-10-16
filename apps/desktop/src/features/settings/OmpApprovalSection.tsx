import { useEffect, useState } from "react";
import type { OmpApprovalMode } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "./primitives";

type Policy = "allow" | "prompt" | "deny";

/** Desktop owns the mode; explicit per-tool rules remain managed by omp. */
export function OmpApprovalSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [mode, setMode] = useState<OmpApprovalMode | null>(null);
  const [rules, setRules] = useState<Record<string, Policy>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTool, setNewTool] = useState("");
  const [newPolicy, setNewPolicy] = useState<Policy>("allow");

  useEffect(() => {
    let disposed = false;
    api.ompApprovalGet()
      .then((result) => {
        if (!disposed) { setMode(result.mode); setRules(result.rules); }
      })
      .catch((e) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { disposed = true; };
  }, []);

  const save = async (input: { mode?: OmpApprovalMode; rules?: Record<string, Policy> }) => {
    setBusy(true);
    try {
      await api.ompApprovalSet(input);
      if (input.mode) {
        setMode(input.mode);
        // Other settings rows save snapshots: do not let a later row restore
        // the mode that was loaded before this independently persisted change.
        useAppStore.setState((state) => state.settings
          ? { settings: { ...state.settings, ompApprovalMode: input.mode } }
          : {});
      }
      if (input.rules) setRules(input.rules);
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const policyOptions = (["allow", "prompt", "deny"] as const).map((policy) => ({
    id: policy, label: t(`settings.ompApproval.policy.${policy}`),
  }));

  return (
    <div data-omp-approval="true">
      <SettingsCard title={t("settings.ompApproval.title")} description={t("settings.ompApproval.description")}>
        {error ? <SettingsRow title={t("settings.ompApproval.error")}>{error}</SettingsRow> : null}
        <SettingsRow title={t("settings.ompApproval.mode")}>
          <div data-omp-approval-mode="true">
            <SettingsMenuSelect
              value={mode ?? ""}
              options={(["always-ask", "write", "yolo"] as const).map((value) => ({
                id: value, label: t(`settings.ompApproval.modes.${value}`),
              }))}
              label={t("settings.ompApproval.mode")}
              disabled={busy || mode === null}
              onChange={(value) => void save({ mode: value as OmpApprovalMode })}
            />
          </div>
        </SettingsRow>
        {Object.entries(rules).map(([tool, policy]) => (
          <SettingsRow key={tool} title={tool}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }} data-omp-approval-rule={tool}>
              <SettingsMenuSelect
                value={policy}
                options={policyOptions}
                label={tool}
                disabled={busy}
                onChange={(value) => void save({ rules: { ...rules, [tool]: value as Policy } })}
              />
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  const next = { ...rules };
                  delete next[tool];
                  void save({ rules: next });
                }}
              >
                {t("settings.ompApproval.remove")}
              </Button>
            </div>
          </SettingsRow>
        ))}
        <SettingsRow title={t("settings.ompApproval.addRule")} description={t("settings.ompApproval.addRuleHint")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              data-omp-approval-new-tool="true"
              aria-label={t("settings.ompApproval.addRule")}
              placeholder="bash"
              value={newTool}
              onChange={(e) => setNewTool(e.target.value)}
            />
            <SettingsMenuSelect
              value={newPolicy}
              options={policyOptions}
              label={t("settings.ompApproval.addRule")}
              onChange={(value) => setNewPolicy(value as Policy)}
              disabled={busy}
            />
            <Button
              style={{ whiteSpace: "nowrap" }}
              disabled={busy || !/^[\w.:-]{1,80}$/.test(newTool.trim())}
              onClick={async () => {
                if (await save({ rules: { ...rules, [newTool.trim()]: newPolicy } })) setNewTool("");
              }}
            >
              {t("settings.ompApproval.add")}
            </Button>
          </div>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
