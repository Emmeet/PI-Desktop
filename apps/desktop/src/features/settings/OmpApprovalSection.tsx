import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

type Mode = "always-ask" | "write" | "yolo";
type Policy = "allow" | "prompt" | "deny";

/**
 * omp tool approvals, stored by omp (`tools.approvalMode` and `tools.approval`
 * in ~/.omp/agent/config.yml) and edited through `omp config set`. Idle chats
 * pick the change up on their next message; a running reply keeps its policy.
 */
export function OmpApprovalSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [mode, setMode] = useState<Mode | null>(null);
  const [rules, setRules] = useState<Record<string, Policy>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTool, setNewTool] = useState("");
  const [newPolicy, setNewPolicy] = useState<Policy>("allow");

  useEffect(() => {
    api.ompApprovalGet()
      .then((result) => { setMode(result.mode); setRules(result.rules); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (input: { mode?: Mode; rules?: Record<string, Policy> }) => {
    setBusy(true);
    try {
      await api.ompApprovalSet(input);
      if (input.mode) setMode(input.mode);
      if (input.rules) setRules(input.rules);
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const policyLabel = (policy: Policy) => t(`settings.ompApproval.policy.${policy}`);

  return (
    <div data-omp-approval="true">
      <SettingsCard title={t("settings.ompApproval.title")} description={t("settings.ompApproval.description")}>
        {error ? <SettingsRow title={t("settings.ompApproval.error")}>{error}</SettingsRow> : null}
        <SettingsRow title={t("settings.ompApproval.mode")}>
          <select
            className="settings-select"
            data-omp-approval-mode="true"
            value={mode ?? ""}
            disabled={busy || mode === null}
            onChange={(e) => void save({ mode: e.target.value as Mode })}
          >
            {mode === null ? <option value="">…</option> : null}
            {(["always-ask", "write", "yolo"] as const).map((value) => (
              <option key={value} value={value}>{t(`settings.ompApproval.modes.${value}`)}</option>
            ))}
          </select>
        </SettingsRow>
        {Object.entries(rules).map(([tool, policy]) => (
          <SettingsRow key={tool} title={tool}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }} data-omp-approval-rule={tool}>
              <select
                className="settings-select"
                value={policy}
                disabled={busy}
                onChange={(e) => void save({ rules: { ...rules, [tool]: e.target.value as Policy } })}
              >
                {(["allow", "prompt", "deny"] as const).map((value) => (
                  <option key={value} value={value}>{policyLabel(value)}</option>
                ))}
              </select>
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
            <input
              className="settings-input"
              data-omp-approval-new-tool="true"
              placeholder="bash"
              value={newTool}
              onChange={(e) => setNewTool(e.target.value)}
            />
            <select className="settings-select" value={newPolicy} onChange={(e) => setNewPolicy(e.target.value as Policy)}>
              {(["allow", "prompt", "deny"] as const).map((value) => (
                <option key={value} value={value}>{policyLabel(value)}</option>
              ))}
            </select>
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
