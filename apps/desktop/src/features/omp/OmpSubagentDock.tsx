import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Markdown } from "../../components/Markdown";
import { IconBot, IconChevronDown, IconChevronUp, IconEye, IconStop } from "../../components/icons";
import { cx } from "../../components/ui";
import { OmpDialog, errorText } from "./OmpDialog";
import "./omp.css";

export type OmpSubagent = {
  id: string;
  index: number;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  task?: string;
  description?: string;
  intent?: string;
  currentTool?: string;
  toolCount?: number;
  tokens?: number;
  recentOutput?: string[];
  sessionFile?: string;
  updatedAt: number;
};

const ACTIVE = new Set(["pending", "running"]);

function compactNumber(value: number | undefined): string {
  if (!value) return "0";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

/** Subagents of one omp chat: live progress, steer, cancel, open transcript. */
export function OmpSubagentDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [agents, setAgents] = useState<OmpSubagent[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [steering, setSteering] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [viewing, setViewing] = useState<OmpSubagent | null>(null);

  useEffect(() => {
    setAgents([]);
    setSteering(null);
    if (!sessionId.startsWith("native-pi:")) return;
    let live = true;
    void api
      .ompCall<{ subagents: OmpSubagent[] }>("omp.subagents.list", { sessionId })
      .then((result) => {
        if (live) setAgents(result.subagents ?? []);
      })
      .catch(() => undefined);
    const off = api.onOmpEvent((event) => {
      if (event.method !== "native.subagents.changed" || event.params?.sessionId !== sessionId) return;
      setAgents(Array.isArray(event.params.subagents) ? event.params.subagents : []);
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId]);

  if (!sessionId.startsWith("native-pi:") || agents.length === 0) return null;
  const running = agents.filter((agent) => ACTIVE.has(agent.status)).length;

  const cancel = async (agent: OmpSubagent) => {
    try {
      await api.ompCall("omp.subagents.cancel", { sessionId, subagentId: agent.id });
    } catch (error) {
      showToast(errorText(error), { variant: "error" });
    }
  };
  const sendSteer = async (agent: OmpSubagent) => {
    const message = draft.trim();
    if (!message) return;
    try {
      await api.ompCall("omp.subagents.steer", { sessionId, subagentId: agent.id, message });
      setDraft("");
      setSteering(null);
      showToast(t("chat.ompSubagents.steered", { agent: agent.agent }), { variant: "success" });
    } catch (error) {
      showToast(errorText(error), { variant: "error" });
    }
  };

  return (
    <div className={cx("omp-subagent-dock", expanded && "is-expanded")}>
      <button type="button" className="omp-subagent-dock-head" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <IconBot size={14} aria-hidden />
        <span className="omp-subagent-dock-title">
          {running > 0
            ? t("chat.ompSubagents.running", { count: running, total: agents.length })
            : t("chat.ompSubagents.done", { total: agents.length })}
        </span>
        {expanded ? <IconChevronDown size={13} /> : <IconChevronUp size={13} />}
      </button>
      {expanded ? (
        <ul className="omp-subagent-list">
          {agents.map((agent) => {
            const active = ACTIVE.has(agent.status);
            return (
              <li key={agent.id} className={cx("omp-subagent", `is-${agent.status}`)}>
                <div className="omp-subagent-row">
                  <span className={cx("omp-subagent-dot", `is-${agent.status}`)} aria-hidden />
                  <span className="omp-subagent-name">{agent.agent}</span>
                  <span className="omp-subagent-task" title={agent.task ?? agent.description}>
                    {agent.description || agent.task || ""}
                  </span>
                  <span className="omp-subagent-meta">
                    {active && agent.currentTool ? `${agent.currentTool} · ` : ""}
                    {t("chat.ompSubagents.meta", { tools: agent.toolCount ?? 0, tokens: compactNumber(agent.tokens) })}
                  </span>
                  <span className="omp-subagent-status">{t(`chat.ompSubagents.status.${agent.status}`)}</span>
                  <span className="omp-subagent-actions">
                    <button type="button" className="omp-mini-btn" title={t("chat.ompSubagents.view")} onClick={() => setViewing(agent)}>
                      <IconEye size={12} />
                    </button>
                    {active ? (
                      <>
                        <button
                          type="button"
                          className="omp-mini-btn"
                          onClick={() => {
                            setSteering(steering === agent.id ? null : agent.id);
                            setDraft("");
                          }}
                        >
                          {t("chat.ompSubagents.steer")}
                        </button>
                        <button type="button" className="omp-mini-btn is-danger" title={t("chat.ompSubagents.cancel")} onClick={() => void cancel(agent)}>
                          <IconStop size={11} />
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
                {active && agent.intent ? <div className="omp-subagent-intent">{agent.intent}</div> : null}
                {steering === agent.id ? (
                  <form
                    className="omp-subagent-steer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendSteer(agent);
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      placeholder={t("chat.ompSubagents.steerPlaceholder")}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <button type="submit" className="omp-mini-btn is-primary" disabled={!draft.trim()}>
                      {t("chat.ompSubagents.send")}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {viewing ? <OmpSubagentTranscript sessionId={sessionId} agent={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function OmpSubagentTranscript({ sessionId, agent, onClose }: { sessionId: string; agent: OmpSubagent; onClose: () => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<UiMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .ompCall<{ messages: UiMessage[] }>("omp.subagents.messages", {
          sessionId,
          subagentId: agent.id,
          ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
        })
        .then((result) => {
          if (live) setMessages(result.messages ?? []);
        })
        .catch((reason) => {
          if (live) setError(errorText(reason));
        });
    void load();
    // A running subagent keeps writing: refresh while the window is open.
    const timer = ACTIVE.has(agent.status) ? setInterval(() => void load(), 2500) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, agent.id, agent.sessionFile, agent.status]);
  return (
    <OmpDialog title={t("chat.ompSubagents.transcriptTitle", { agent: agent.agent })} icon={<IconBot size={15} />} className="omp-subagent-dialog" onClose={onClose}>
      {agent.task ? <div className="omp-subagent-assignment">{agent.task}</div> : null}
      {error ? <div className="omp-error">{error}</div> : null}
      {messages === null && !error ? <div className="omp-muted">{t("common.loading")}</div> : null}
      {messages?.length === 0 ? <div className="omp-muted">{t("chat.ompSubagents.empty")}</div> : null}
      <div className="omp-transcript">
        {messages?.filter((message) => message.role === "tool" || String(message.content ?? "").trim()).map((message) => (
          <div key={message.id} className={cx("omp-transcript-row", `is-${message.role}`)}>
            <div className="omp-transcript-role">
              {message.role === "tool" ? `⚙ ${message.toolName ?? "tool"}` : message.role}
            </div>
            {message.role === "tool" ? (
              <pre className="omp-transcript-tool">{String(message.content ?? "").slice(0, 2000)}</pre>
            ) : (
              <Markdown source={String(message.content ?? "")} renderDiagrams={false} />
            )}
          </div>
        ))}
      </div>
    </OmpDialog>
  );
}
