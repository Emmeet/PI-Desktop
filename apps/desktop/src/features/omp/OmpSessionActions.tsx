import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { IconDownload, IconHelp, IconMore, IconRefresh, IconTarget, IconClose } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { TooltipButton } from "../../components/ui";
import { OmpDialog, errorText } from "./OmpDialog";
import "./omp.css";

// ---- Loop (app-side: omp's /loop is TUI-only) ------------------------------

export type OmpLoop = { prompt: string; total: number; done: number };
const loops = new Map<string, OmpLoop>();
const loopListeners = new Set<() => void>();
const emitLoops = () => loopListeners.forEach((listener) => listener());
export function setOmpLoop(sessionId: string, loop: OmpLoop | null): void {
  if (loop) loops.set(sessionId, loop);
  else loops.delete(sessionId);
  emitLoops();
}
function useOmpLoop(sessionId: string | null | undefined): OmpLoop | null {
  return useSyncExternalStore(
    (listener) => {
      loopListeners.add(listener);
      return () => loopListeners.delete(listener);
    },
    () => (sessionId ? loops.get(sessionId) ?? null : null),
  );
}

/** Re-sends the loop prompt each time the chat goes idle, until the count runs out. */
export function OmpLoopDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const loop = useOmpLoop(sessionId);
  const isRunning = useAppStore((state) => state.isRunning);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    const finished = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!finished || !loop) return;
    if (loop.done >= loop.total) {
      setOmpLoop(sessionId, null);
      return;
    }
    const next = { ...loop, done: loop.done + 1 };
    setOmpLoop(sessionId, next);
    void sendPrompt(loop.prompt, undefined, sessionId).then((ok) => {
      if (!ok) setOmpLoop(sessionId, null);
    });
  }, [isRunning, loop, sessionId, sendPrompt]);
  if (!loop) return null;
  return (
    <div className="omp-loop-dock" data-omp-loop="true">
      <IconRefresh size={13} aria-hidden />
      <span className="omp-loop-text">{t("chat.ompActions.loopRunning", { done: loop.done, total: loop.total })}</span>
      <span className="omp-loop-prompt" title={loop.prompt}>{loop.prompt}</span>
      <button type="button" className="omp-mini-btn" onClick={() => setOmpLoop(sessionId, null)}>
        {t("chat.ompActions.loopStop")}
      </button>
    </div>
  );
}

// ---- Topbar menu ------------------------------------------------------------

type Panel = "btw" | "goal" | "loop" | "handoff" | null;

/** Topbar "omp" menu: export, side question, goal, loop, handoff, slow mode. */
export function OmpSessionActionsButton() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  if (!sessionId?.startsWith("native-pi:")) return null;
  const title = sessions.find((session) => session.id === sessionId)?.title ?? "omp-session";
  const pick = (next: Panel) => {
    setOpen(false);
    setPanel(next);
  };
  const exportHtml = async () => {
    setOpen(false);
    try {
      const { path } = await api.ompExportHtml({ sessionId, title });
      if (path) showToast(t("chat.ompActions.exported", { path }), { variant: "success" });
    } catch (error) {
      showToast(errorText(error), { variant: "error" });
    }
  };
  const slowMode = async (enabled: boolean) => {
    setOpen(false);
    try {
      const reply = await api.ompSessionCommand<{ enabled: boolean }>(sessionId, { type: "set_slow_mode", enabled });
      showToast(reply.enabled ? t("chat.ompActions.slowOn") : t("chat.ompActions.slowOff"), { variant: "success" });
    } catch (error) {
      showToast(errorText(error), { variant: "error" });
    }
  };
  const item = (key: string, label: string, onSelect: () => void, icon?: React.ReactNode) => (
    <button key={key} type="button" role="menuitem" data-omp-action={key} className="composer-plus-item composer-menu-entry" onClick={onSelect}>
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <>
      <AnchoredMenu
        className="omp-actions"
        open={open}
        onClose={() => setOpen(false)}
        menuClassName="composer-model-menu omp-actions-menu"
        label={t("chat.ompActions.open")}
        role="menu"
        align="end"
        side="bottom"
        trigger={(ref) => (
          <TooltipButton
            ref={ref}
            type="button"
            className="ct-icon-btn omp-actions-btn"
            tooltip={t("chat.ompActions.open")}
            ariaLabel={t("chat.ompActions.open")}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <IconMore size={15} />
          </TooltipButton>
        )}
      >
        <div className="composer-menu-root">
          {item("export", t("chat.ompActions.export"), () => void exportHtml(), <IconDownload size={14} />)}
          {item("btw", t("chat.ompActions.btw"), () => pick("btw"), <IconHelp size={14} />)}
          {item("goal", t("chat.ompActions.goal"), () => pick("goal"), <IconTarget size={14} />)}
          {item("loop", t("chat.ompActions.loop"), () => pick("loop"), <IconRefresh size={14} />)}
          {item("handoff", t("chat.ompActions.handoff"), () => pick("handoff"))}
          {item("slow-on", t("chat.ompActions.slowEnable"), () => void slowMode(true))}
          {item("slow-off", t("chat.ompActions.slowDisable"), () => void slowMode(false))}
        </div>
      </AnchoredMenu>
      {panel === "btw" ? <BtwDialog sessionId={sessionId} onClose={() => setPanel(null)} /> : null}
      {panel === "goal" ? <GoalDialog sessionId={sessionId} onClose={() => setPanel(null)} /> : null}
      {panel === "loop" ? <LoopDialog sessionId={sessionId} onClose={() => setPanel(null)} /> : null}
      {panel === "handoff" ? <HandoffDialog sessionId={sessionId} onClose={() => setPanel(null)} /> : null}
    </>
  );
}

type BtwTurn = { question: string; answer: string; status: string; error?: string };
type BtwRecord = BtwTurn & { id?: string; followUps?: BtwTurn[] };

function BtwDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<BtwTurn[]>([]);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recordId = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      api.onOmpEvent((event) => {
        if (event.method !== "native.btw" || event.params?.sessionId !== sessionId) return;
        const frame = event.params.frame ?? {};
        if (frame.type === "btw_delta" && typeof frame.delta === "string") setLive((current) => current + frame.delta);
      }),
    [sessionId],
  );
  const ask = async () => {
    const text = question.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setLive("");
    setTurns((current) => [...current, { question: text, answer: "", status: "running" }]);
    setQuestion("");
    try {
      const reply = await api.ompSessionCommand<{ record: BtwRecord }>(sessionId, { type: "btw", question: text, ...(recordId.current ? { recordId: recordId.current } : {}) });
      recordId.current = reply.record?.id ?? recordId.current;
      if (reply.record) setTurns([reply.record, ...(reply.record.followUps ?? [])]);
    } catch (reason) {
      setError(errorText(reason));
      setTurns((current) => current.slice(0, -1));
    } finally {
      setBusy(false);
      setLive("");
    }
  };
  return (
    <OmpDialog title={t("chat.ompActions.btwTitle")} icon={<IconHelp size={15} />} className="omp-btw-dialog" onClose={onClose}>
      <p className="omp-muted">{t("chat.ompActions.btwHint")}</p>
      <div className="omp-transcript" data-omp-btw="true">
        {turns.map((turn, index) => (
          <div key={index} className="omp-btw-turn">
            <div className="omp-transcript-row is-user">{turn.question}</div>
            <div className="omp-transcript-row is-assistant">
              {turn.status === "running" ? (live ? <Markdown source={live} renderDiagrams={false} /> : <span className="omp-muted">{t("common.loading")}</span>) : turn.error ? <span className="omp-error">{turn.error}</span> : <Markdown source={turn.answer} renderDiagrams={false} />}
            </div>
          </div>
        ))}
      </div>
      {error ? <div className="omp-error">{error}</div> : null}
      <form
        className="omp-login-row"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input className="settings-input omp-login-input" autoFocus value={question} placeholder={t("chat.ompActions.btwPlaceholder")} onChange={(event) => setQuestion(event.target.value)} />
        <button type="submit" className="omp-mini-btn" disabled={busy || !question.trim()}>{t("chat.ompActions.ask")}</button>
      </form>
    </OmpDialog>
  );
}

type GoalState = { goal: { objective?: string; status?: string; tokensUsed?: number; tokenBudget?: number } | null; state: unknown };

function GoalDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState<GoalState["goal"] | undefined>(undefined);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (op: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api.ompSessionCommand<GoalState>(sessionId, { type: "goal", op, ...extra });
      setGoal(reply?.goal ?? null);
    } catch (reason) {
      setError(errorText(reason));
      if (goal === undefined) setGoal(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run("get");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  return (
    <OmpDialog title={t("chat.ompActions.goalTitle")} icon={<IconTarget size={15} />} className="omp-goal-dialog" onClose={onClose}>
      <p className="omp-muted">{t("chat.ompActions.goalHint")}</p>
      {goal === undefined ? <div className="omp-muted">{t("common.loading")}</div> : null}
      {goal ? (
        <div className="omp-goal-current" data-omp-goal="true">
          <strong>{goal.objective}</strong>
          <span className="omp-muted">{t("chat.ompActions.goalStatus", { status: goal.status ?? "active" })}</span>
          <div className="omp-login-row">
            {goal.status === "paused" ? (
              <button type="button" className="omp-mini-btn" disabled={busy} onClick={() => void run("resume")}>{t("chat.ompActions.goalResume")}</button>
            ) : (
              <button type="button" className="omp-mini-btn" disabled={busy} onClick={() => void run("pause")}>{t("chat.ompActions.goalPause")}</button>
            )}
            <button type="button" className="omp-mini-btn" disabled={busy} onClick={() => void run("drop")}>{t("chat.ompActions.goalDrop")}</button>
          </div>
        </div>
      ) : null}
      {goal === null ? (
        <form
          className="omp-login-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (objective.trim()) void run("create", { objective: objective.trim() });
          }}
        >
          <input className="settings-input omp-login-input" autoFocus value={objective} placeholder={t("chat.ompActions.goalPlaceholder")} onChange={(event) => setObjective(event.target.value)} />
          <button type="submit" className="omp-mini-btn" disabled={busy || !objective.trim()}>{t("chat.ompActions.goalSet")}</button>
        </form>
      ) : null}
      {error ? <div className="omp-error">{error}</div> : null}
    </OmpDialog>
  );
}

function LoopDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const isRunning = useAppStore((state) => state.isRunning);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(3);
  const start = async () => {
    const text = prompt.trim();
    if (!text || count < 1) return;
    setOmpLoop(sessionId, { prompt: text, total: count, done: 1 });
    onClose();
    if (!isRunning) {
      const ok = await sendPrompt(text, undefined, sessionId);
      if (!ok) setOmpLoop(sessionId, null);
    }
  };
  return (
    <OmpDialog title={t("chat.ompActions.loopTitle")} icon={<IconRefresh size={15} />} className="omp-loop-dialog" onClose={onClose}>
      <p className="omp-muted">{t("chat.ompActions.loopHint")}</p>
      <form
        className="omp-login-step"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <textarea className="settings-input omp-login-input" rows={3} autoFocus value={prompt} placeholder={t("chat.ompActions.loopPlaceholder")} onChange={(event) => setPrompt(event.target.value)} />
        <div className="omp-login-row">
          <label className="omp-muted" htmlFor="omp-loop-count">{t("chat.ompActions.loopCount")}</label>
          <input id="omp-loop-count" className="settings-input omp-loop-count" type="number" min={1} max={50} value={count} onChange={(event) => setCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} />
          <button type="submit" className="omp-mini-btn" disabled={!prompt.trim()}>{t("chat.ompActions.loopStart")}</button>
        </div>
      </form>
    </OmpDialog>
  );
}

function HandoffDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const selectSession = useAppStore((state) => state.selectSession);
  const showToast = useAppStore((state) => state.showToast);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.ompSessionCommand(sessionId, { type: "handoff", ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}) });
      showToast(t("chat.ompActions.handoffDone"), { variant: "success" });
      await selectSession(sessionId);
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <OmpDialog
      title={t("chat.ompActions.handoffTitle")}
      className="omp-handoff-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="omp-mini-btn" onClick={onClose}>
            <IconClose size={12} /> {t("common.cancel")}
          </button>
          <button type="button" className="omp-mini-btn" disabled={busy} onClick={() => void run()}>
            {busy ? t("common.loading") : t("chat.ompActions.handoffRun")}
          </button>
        </>
      }
    >
      <p className="omp-muted">{t("chat.ompActions.handoffHint")}</p>
      <textarea className="settings-input omp-login-input" rows={3} value={instructions} placeholder={t("chat.ompActions.handoffPlaceholder")} onChange={(event) => setInstructions(event.target.value)} />
      {error ? <div className="omp-error">{error}</div> : null}
    </OmpDialog>
  );
}
