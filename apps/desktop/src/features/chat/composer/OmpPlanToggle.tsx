import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { IconListChecks, IconPlay } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

/**
 * Desktop plan mode for an omp chat. omp's own /plan is TUI-only, so the app
 * restarts the chat's omp process read-only (writes and commands are denied)
 * with a planning instruction; "Run plan" switches back and asks omp to do it.
 */
export function OmpPlanToggle({
  session,
  running,
  controlsBlocked,
}: {
  session: SessionSummary | null | undefined;
  running: boolean;
  controlsBlocked: boolean;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const sessionId = session?.id;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(false);
    if (!sessionId) return;
    let live = true;
    api.ompPlanGet(sessionId).then((r) => { if (live) setEnabled(r.enabled); }).catch(() => undefined);
    return () => { live = false; };
  }, [sessionId]);

  if (!sessionId) return null;

  const set = async (next: boolean) => {
    setBusy(true);
    try {
      const result = await api.ompPlanSet(sessionId, next);
      setEnabled(result.enabled);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!(await set(false))) return;
    await sendPrompt(t("chat.ompPlanExecutePrompt"), undefined, sessionId);
  };

  return (
    <>
      <TooltipButton
        type="button"
        className={`icon-btn mode-chip composer-mode-chip omp-plan-chip${enabled ? " is-active" : ""}`}
        tooltip={enabled ? t("chat.ompPlanOnHint") : t("chat.ompPlanOffHint")}
        ariaLabel={t("chat.ompPlan")}
        aria-pressed={enabled}
        disabled={busy || running || controlsBlocked}
        onClick={() => void set(!enabled)}
      >
        <IconListChecks size={14} aria-hidden="true" />
        <span className="composer-mode-chip-label text-sm">{t("chat.ompPlan")}</span>
      </TooltipButton>
      {enabled ? (
        <TooltipButton
          type="button"
          className="icon-btn mode-chip composer-mode-chip omp-plan-run"
          tooltip={t("chat.ompPlanExecuteHint")}
          ariaLabel={t("chat.ompPlanExecute")}
          disabled={busy || running || controlsBlocked}
          onClick={() => void execute()}
        >
          <IconPlay size={13} aria-hidden="true" />
          <span className="composer-mode-chip-label text-sm">{t("chat.ompPlanExecute")}</span>
        </TooltipButton>
      ) : null}
    </>
  );
}
