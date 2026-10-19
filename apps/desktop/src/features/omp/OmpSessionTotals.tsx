import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatCost, formatTokens } from "../settings/OmpUsagePage";

type Stats = {
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  cost?: number;
  premiumRequests?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};

/** Whole-chat totals from omp (`get_session_stats`), shown in the context popover. */
export function OmpSessionTotals({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const { t } = useTranslation();
  // Scoped to the session the request belongs to: a switch must not show the previous chat's totals.
  const [stats, setStats] = useState<{ sessionId: string; value: Stats | null } | null>(null);
  const [failed, setFailed] = useState<{ sessionId: string } | null>(null);
  useEffect(() => {
    let live = true;
    setFailed(null);
    api
      .ompCall<{ stats: Stats }>("omp.stats", { sessionId })
      .then((result) => {
        if (live) setStats({ sessionId, value: result.stats ?? null });
      })
      .catch(() => {
        if (live) setFailed({ sessionId });
      });
    return () => {
      live = false;
    };
  }, [sessionId, refreshKey]);
  const shown = stats?.sessionId === sessionId ? stats.value : null;
  if (failed?.sessionId === sessionId) return null;
  return (
    <div className="context-inspector-summary-row omp-session-totals" data-omp-session-totals="true">
      <strong>{t("chat.ompSessionTotals")}</strong>
      <span className="context-inspector-summary-values">
        {shown ? (
          <>
            <span>{t("chat.usageInput")} {formatTokens(shown.tokens?.input)}</span>
            <span>{t("chat.usageOutput")} {formatTokens(shown.tokens?.output)}</span>
            <span>{t("chat.usageCacheRead")} {formatTokens(shown.tokens?.cacheRead)}</span>
            <span>{t("chat.ompSessionCost")} {formatCost(shown.cost)}</span>
            <span>{t("chat.ompSessionTurns", { count: shown.assistantMessages ?? 0, tools: shown.toolCalls ?? 0 })}</span>
          </>
        ) : (
          <span>{t("common.loading")}</span>
        )}
      </span>
    </div>
  );
}
