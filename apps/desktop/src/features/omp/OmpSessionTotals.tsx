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
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    api
      .ompCall<{ stats: Stats }>("omp.stats", { sessionId })
      .then((result) => {
        if (live) setStats(result.stats ?? null);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [sessionId, refreshKey]);
  if (failed) return null;
  return (
    <div className="context-inspector-summary-row omp-session-totals" data-omp-session-totals="true">
      <strong>{t("chat.ompSessionTotals")}</strong>
      <span className="context-inspector-summary-values">
        {stats ? (
          <>
            <span>{t("chat.usageInput")} {formatTokens(stats.tokens?.input)}</span>
            <span>{t("chat.usageOutput")} {formatTokens(stats.tokens?.output)}</span>
            <span>{t("chat.usageCacheRead")} {formatTokens(stats.tokens?.cacheRead)}</span>
            <span>{t("chat.ompSessionCost")} {formatCost(stats.cost)}</span>
            <span>{t("chat.ompSessionTurns", { count: stats.assistantMessages ?? 0, tools: stats.toolCalls ?? 0 })}</span>
          </>
        ) : (
          <span>{t("common.loading")}</span>
        )}
      </span>
    </div>
  );
}
