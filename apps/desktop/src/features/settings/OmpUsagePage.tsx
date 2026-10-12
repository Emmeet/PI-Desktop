import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type OmpUsageRow, type OmpUsageStats } from "../../lib/api";
import { Button } from "../../components/ui";
import { errorText } from "../omp/OmpDialog";
import { SettingsCard } from "./primitives";
import "../omp/omp.css";

export function formatTokens(value: number | undefined): string {
  const n = value ?? 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCost(value: number | undefined): string {
  const n = value ?? 0;
  return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function UsageTable({ rows, label }: { rows: OmpUsageRow[]; label: (row: OmpUsageRow) => string }) {
  const { t } = useTranslation();
  const sorted = [...rows].sort((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0) || (b.totalRequests ?? 0) - (a.totalRequests ?? 0));
  return (
    <table className="omp-usage-table">
      <thead>
        <tr>
          <th />
          <th>{t("settings.ompUsage.requests")}</th>
          <th>{t("settings.ompUsage.input")}</th>
          <th>{t("settings.ompUsage.output")}</th>
          <th>{t("settings.ompUsage.cacheRead")}</th>
          <th>{t("settings.ompUsage.cost")}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, index) => (
          <tr key={index}>
            <td className="omp-usage-label" title={label(row)}>{label(row)}</td>
            <td>{row.totalRequests ?? 0}</td>
            <td>{formatTokens(row.totalInputTokens)}</td>
            <td>{formatTokens(row.totalOutputTokens)}</td>
            <td>{formatTokens(row.totalCacheReadTokens)}</td>
            <td>{formatCost(row.totalCost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Whole-install usage from omp's own stats database (`omp stats --json`). */
export function OmpUsagePage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<OmpUsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    setError(null);
    api
      .ompUsageStats()
      .then(setStats)
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  const overall = stats?.overall;
  const since = overall?.firstTimestamp ? new Date(overall.firstTimestamp).toLocaleDateString() : null;
  return (
    <div className="settings-stack omp-usage" data-omp-usage="true">
      <SettingsCard
        title={t("settings.ompUsage.title")}
        description={since ? t("settings.ompUsage.since", { date: since }) : t("settings.ompUsage.description")}
      >
        <div className="omp-usage-head">
          {error ? <span className="omp-error">{error}</span> : null}
          <Button type="button" variant="secondary" disabled={loading} onClick={load}>
            {loading ? t("common.loading") : t("settings.ompUsage.refresh")}
          </Button>
        </div>
        {overall ? (
          <div className="omp-usage-totals">
            <div><span>{t("settings.ompUsage.requests")}</span><strong>{overall.totalRequests ?? 0}</strong></div>
            <div><span>{t("settings.ompUsage.input")}</span><strong>{formatTokens(overall.totalInputTokens)}</strong></div>
            <div><span>{t("settings.ompUsage.output")}</span><strong>{formatTokens(overall.totalOutputTokens)}</strong></div>
            <div><span>{t("settings.ompUsage.cacheRead")}</span><strong>{formatTokens(overall.totalCacheReadTokens)}</strong></div>
            <div><span>{t("settings.ompUsage.cost")}</span><strong>{formatCost(overall.totalCost)}</strong></div>
            <div><span>{t("settings.ompUsage.failed")}</span><strong>{overall.failedRequests ?? 0}</strong></div>
          </div>
        ) : null}
      </SettingsCard>
      {stats?.byModel.length ? (
        <SettingsCard title={t("settings.ompUsage.byModel")}>
          <UsageTable rows={stats.byModel} label={(row) => `${row.provider ?? ""}/${row.model ?? ""}`} />
        </SettingsCard>
      ) : null}
      {stats?.byFolder.length ? (
        <SettingsCard title={t("settings.ompUsage.byFolder")}>
          <UsageTable rows={stats.byFolder} label={(row) => row.folder ?? ""} />
        </SettingsCard>
      ) : null}
      {stats?.byAgentType.length ? (
        <SettingsCard title={t("settings.ompUsage.byAgent")}>
          <UsageTable rows={stats.byAgentType} label={(row) => row.agentType ?? ""} />
        </SettingsCard>
      ) : null}
    </div>
  );
}
