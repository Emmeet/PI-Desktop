import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { IconDownload, IconHelp, IconMore, IconRefresh, IconTarget, IconClose } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button, Input, Textarea, TooltipButton } from "../../components/ui";
import { OmpDialog, errorText } from "./OmpDialog";
import { BtwActions, GoalActions, runHandoff, type BtwState, type GoalState, type OmpLoop } from "./session-actions";
import "./omp.css";

/** Loop execution lives in the runtime, not this session's mounted composer. */
export function OmpLoopDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{ sessionId: string; loop: OmpLoop | null }>({ sessionId, loop: null });
  const [busySession, setBusySession] = useState<string | null>(null);
  const stopping = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    setSnapshot({ sessionId, loop: null });
    const off = api.onOmpEvent((event) => {
      if (event.method !== "native.loop" || event.params.sessionId !== sessionId) return;
      revision++;
      setSnapshot({ sessionId, loop: event.params.loop ?? null });
    });
    if (sessionId.startsWith("native-pi:")) {
      const initialRevision = revision;
      void api.ompSessionCommand<{ loop: OmpLoop | null }>(sessionId, { type: "get_loop" }).then((reply) => {
        if (!disposed && revision === initialRevision) setSnapshot({ sessionId, loop: reply.loop });
      }).catch((error) => {
        if (!disposed) useAppStore.getState().showToast(errorText(error), { variant: "error" });
      });
    }
    return () => { disposed = true; off(); };
  }, [sessionId]);
  const loop = snapshot.sessionId === sessionId ? snapshot.loop : null;
  if (!loop) return null;
  return (
    <div className="omp-loop-dock" data-omp-loop="true">
      <IconRefresh size={13} aria-hidden />
      <span className="omp-loop-text">{t("chat.ompActions.loopRunning", { done: loop.done, total: loop.total })}</span>
      <span className="omp-loop-prompt" title={loop.prompt}>{loop.prompt}</span>
      <Button type="button" size="sm" variant="ghost" className="omp-mini-btn" disabled={busySession === sessionId} onClick={() => {
        if (stopping.current.has(sessionId)) return;
        stopping.current.add(sessionId);
        setBusySession(sessionId);
        void api.ompSessionCommand(sessionId, { type: "loop_stop" }).catch((error) => {
          useAppStore.getState().showToast(errorText(error), { variant: "error" });
        }).finally(() => {
          stopping.current.delete(sessionId);
          setBusySession((current) => current === sessionId ? null : current);
        });
      }}>{t("chat.ompActions.loopStop")}</Button>
    </div>
  );
}

type Panel = "share" | "btw" | "goal" | "loop" | "handoff";

export function OmpSessionActionsButton() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<{ sessionId: string; name: Panel } | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setOpen(false); setPanel(null); }, [sessionId]);
  if (!sessionId?.startsWith("native-pi:")) return null;
  const title = sessions.find((session) => session.id === sessionId)?.title ?? "omp-session";
  const pick = (name: Panel) => { setOpen(false); setPanel({ sessionId, name }); };
  const closePanel = () => { setPanel(null); triggerRef.current?.focus(); };
  const slowMode = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const reply = await api.ompSessionCommand<{ enabled: boolean }>(sessionId, { type: "set_slow_mode", enabled });
      showToast(reply.enabled ? t("chat.ompActions.slowOn") : t("chat.ompActions.slowOff"), { variant: "success" });
    } catch (error) {
      showToast(errorText(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };
  const item = (key: string, label: string, onSelect: () => void, icon?: ReactNode) => (
    <Button key={key} type="button" variant="ghost" role="menuitem" disabled={busy} data-omp-action={key} className="composer-plus-item composer-menu-entry" onClick={onSelect}>
      {icon}<span>{label}</span>
    </Button>
  );
  const currentPanel = panel?.sessionId === sessionId ? panel.name : null;
  return (
    <>
      <AnchoredMenu className="omp-actions" open={open} onClose={() => setOpen(false)} restoreFocus={!currentPanel} menuClassName="composer-model-menu omp-actions-menu" label={t("chat.ompActions.open")} role="menu" align="end" side="bottom" trigger={(ref) => (
        <TooltipButton ref={(node) => { ref.current = node; triggerRef.current = node; }} type="button" className="ct-icon-btn omp-actions-btn" tooltip={t("chat.ompActions.open")} ariaLabel={t("chat.ompActions.open")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <IconMore size={15} />
        </TooltipButton>
      )}>
        <div className="composer-menu-root">
          {item("export", t("chat.ompActions.share"), () => pick("share"), <IconDownload size={14} />)}
          {item("btw", t("chat.ompActions.btw"), () => pick("btw"), <IconHelp size={14} />)}
          {item("goal", t("chat.ompActions.goal"), () => pick("goal"), <IconTarget size={14} />)}
          {item("loop", t("chat.ompActions.loop"), () => pick("loop"), <IconRefresh size={14} />)}
          {item("handoff", t("chat.ompActions.handoff"), () => pick("handoff"))}
          {item("slow-on", t("chat.ompActions.slowEnable"), () => void slowMode(true))}
          {item("slow-off", t("chat.ompActions.slowDisable"), () => void slowMode(false))}
          {item("new-window", t("chat.ompActions.newWindow"), () => {
            setOpen(false);
            void api.newChatWindow().catch((error) => showToast(errorText(error), { variant: "error" }));
          })}
        </div>
      </AnchoredMenu>
      {currentPanel === "share" ? <ExportDialog key={sessionId} sessionId={sessionId} title={title} onClose={closePanel} /> : null}
      {currentPanel === "btw" ? <BtwDialog key={sessionId} sessionId={sessionId} onClose={closePanel} /> : null}
      {currentPanel === "goal" ? <GoalDialog key={sessionId} sessionId={sessionId} onClose={closePanel} /> : null}
      {currentPanel === "loop" ? <LoopDialog key={sessionId} sessionId={sessionId} onClose={closePanel} /> : null}
      {currentPanel === "handoff" ? <HandoffDialog key={sessionId} sessionId={sessionId} onClose={closePanel} /> : null}
    </>
  );
}

function ExportDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (action: "save" | "open" | "reveal" | "copy") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === "save") {
        const result = await api.ompExportHtml({ sessionId, title });
        if (alive.current) setPath(result.path);
      } else if (path) {
        if (action === "open") await api.ompOpenExport(path);
        if (action === "reveal") await api.ompRevealExport(path);
        if (action === "copy") {
          await navigator.clipboard.writeText(path);
          if (alive.current) useAppStore.getState().showToast(t("chat.ompActions.exportPathCopied"), { variant: "success" });
        }
      }
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <OmpDialog title={t("chat.ompActions.shareTitle")} icon={<IconDownload size={15} />} onClose={() => { if (!pending.current) onClose(); }}>
      <p className="omp-muted">{t("chat.ompActions.shareHint")}</p>
      <Button type="button" size="sm" disabled={busy} onClick={() => void run("save")}>{busy ? t("common.loading") : t("chat.ompActions.exportSave")}</Button>
      {path ? <><p className="omp-muted">{t("chat.ompActions.exported", { path })}</p><div className="omp-login-row">
        <Button type="button" size="sm" disabled={busy} onClick={() => void run("open")}>{t("chat.ompActions.exportOpen")}</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void run("reveal")}>{t("chat.ompActions.exportReveal")}</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void run("copy")}>{t("chat.ompActions.exportCopyPath")}</Button>
      </div></> : null}
      {error ? <div className="omp-error" role="alert">{error}</div> : null}
    </OmpDialog>
  );
}

function BtwDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<BtwState>({ records: [], busy: false, loading: true, error: null });
  const actions = useRef<BtwActions | null>(null);
  useEffect(() => {
    const controller = new BtwActions(sessionId, api.ompSessionCommand);
    actions.current = controller;
    const offState = controller.subscribe(() => setState(controller.getSnapshot()));
    const offEvent = api.onOmpEvent(controller.event);
    void controller.load();
    return () => { actions.current = null; offState(); offEvent(); controller.dispose(); };
  }, [sessionId]);
  const record = state.records.find((entry) => entry.id === state.selectedId);
  const turns = [...(record ? [record, ...(record.followUps ?? [])] : []), ...(state.pending ? [state.pending] : [])];
  return (
    <OmpDialog title={t("chat.ompActions.btwTitle")} icon={<IconHelp size={15} />} className="omp-btw-dialog" onClose={onClose}>
      <p className="omp-muted">{t("chat.ompActions.btwHint")}</p>
      <div className="omp-login-row">
        <Button type="button" size="sm" disabled={state.busy || state.loading} onClick={() => actions.current?.select()}>{t("chat.ompActions.btwNewTopic")}</Button>
        {state.busy ? <Button type="button" size="sm" onClick={() => void actions.current?.cancel()}>{t("chat.ompActions.btwCancel")}</Button> : null}
      </div>
      {state.loading ? <div className="omp-muted">{t("common.loading")}</div> : null}
      {state.records.length > 1 || !state.selectedId ? <div className="omp-login-step">{state.records.map((entry) => (
        <Button key={entry.id} type="button" size="sm" variant="ghost" disabled={state.busy} aria-label={`${t("chat.ompActions.btwContinue")}: ${entry.question}`} aria-pressed={state.selectedId === entry.id} onClick={() => actions.current?.select(entry.id)}>{entry.question}</Button>
      ))}</div> : null}
      <div className="omp-transcript" data-omp-btw="true" aria-live="polite" aria-busy={state.busy}>
        {turns.map((turn, index) => <div key={index} className="omp-btw-turn">
          <div className="omp-transcript-row is-user">{turn.question}</div>
          <div className="omp-transcript-row is-assistant">{turn.error ? <span className="omp-error">{turn.error}</span> : turn.answer ? <Markdown source={turn.answer} renderDiagrams={false} /> : turn.status === "running" ? <span className="omp-muted">{t("common.loading")}</span> : null}</div>
          {turn.status === "cancelled" || turn.status === "interrupted" ? <span className="omp-muted">{t("chat.ompActions.btwCancelled")}</span> : null}
        </div>)}
      </div>
      {state.error ? <div className="omp-error" role="alert">{errorText(state.error)}<Button type="button" size="sm" disabled={state.busy || state.loading} onClick={() => void actions.current?.load()}>{t("chat.ompActions.retry")}</Button></div> : null}
      <form className="omp-login-row" onSubmit={(event) => {
        event.preventDefault();
        const controller = actions.current;
        if (!controller || controller.getSnapshot().busy || controller.getSnapshot().loading || !question.trim()) return;
        const text = question;
        setQuestion("");
        void controller.ask(text).then((ok) => {
          if (!ok && actions.current === controller) setQuestion((current) => current || text);
        });
      }}>
        <Input className="omp-login-input" autoFocus value={question} disabled={state.loading || state.busy} aria-label={t("chat.ompActions.btwPlaceholder")} placeholder={t("chat.ompActions.btwPlaceholder")} onChange={(event) => setQuestion(event.target.value)} />
        <Button type="submit" size="sm" disabled={state.loading || state.busy || !question.trim()}>{t("chat.ompActions.ask")}</Button>
      </form>
    </OmpDialog>
  );
}

function GoalDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<GoalState>({ goal: undefined, busy: false, error: null });
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const actions = useRef<GoalActions | null>(null);
  useEffect(() => {
    const controller = new GoalActions(sessionId, api.ompSessionCommand);
    actions.current = controller;
    const offState = controller.subscribe(() => setState(controller.getSnapshot()));
    const offEvent = api.onOmpEvent(controller.event);
    void controller.run("get");
    return () => { actions.current = null; offState(); offEvent(); controller.dispose(); };
  }, [sessionId]);
  const goal = state.goal;
  const validBudget = !budget || (Number.isSafeInteger(Number(budget)) && Number(budget) > 0);
  const statusKeys = { active: "goalStatusActive", paused: "goalStatusPaused", "budget-limited": "goalStatusBudgetLimited", complete: "goalStatusComplete", dropped: "goalStatusDropped" };
  return (
    <OmpDialog title={t("chat.ompActions.goalTitle")} icon={<IconTarget size={15} />} className="omp-goal-dialog" onClose={() => { if (!actions.current?.getSnapshot().busy) onClose(); }}>
      <p className="omp-muted">{t("chat.ompActions.goalHint")}</p>
      {goal === undefined && state.busy ? <div className="omp-muted">{t("common.loading")}</div> : null}
      {goal ? <div className="omp-goal-current" data-omp-goal="true" aria-live="polite">
        <strong>{goal.objective}</strong>
        <span className="omp-muted">{t("chat.ompActions.goalStatus", { status: t(`chat.ompActions.${statusKeys[goal.status]}`) })}</span>
        <span className="omp-muted">{t(goal.tokenBudget ? "chat.ompActions.goalUsage" : "chat.ompActions.goalUsageUnbounded", { used: goal.tokensUsed, budget: goal.tokenBudget })}</span>
        <div className="omp-login-row">
          {goal.status === "paused" || goal.status === "budget-limited" ? <Button type="button" size="sm" disabled={state.busy} onClick={() => void actions.current?.run("resume")}>{t("chat.ompActions.goalResume")}</Button> : goal.status === "active" ? <Button type="button" size="sm" disabled={state.busy} onClick={() => void actions.current?.run("pause")}>{t("chat.ompActions.goalPause")}</Button> : null}
          <Button type="button" size="sm" disabled={state.busy} onClick={() => void actions.current?.run("drop")}>{t("chat.ompActions.goalDrop")}</Button>
        </div>
      </div> : null}
      {goal === null ? <form className="omp-login-step" onSubmit={(event) => {
        event.preventDefault();
        if (objective.trim() && validBudget) void actions.current?.run("create", { objective: objective.trim(), ...(budget ? { token_budget: Number(budget) } : {}) });
      }}>
        <Input className="omp-login-input" autoFocus value={objective} disabled={state.busy} aria-label={t("chat.ompActions.goalPlaceholder")} placeholder={t("chat.ompActions.goalPlaceholder")} onChange={(event) => setObjective(event.target.value)} />
        <Input type="number" min={1} step={1} value={budget} disabled={state.busy} aria-label={t("chat.ompActions.goalBudget")} placeholder={t("chat.ompActions.goalBudget")} onChange={(event) => setBudget(event.target.value)} />
        <Button type="submit" size="sm" disabled={state.busy || !objective.trim() || !validBudget}>{t("chat.ompActions.goalSet")}</Button>
      </form> : null}
      {state.error ? <div className="omp-error" role="alert">{errorText(state.error)}<Button type="button" size="sm" disabled={state.busy} onClick={() => void actions.current?.run("get")}>{t("chat.ompActions.retry")}</Button></div> : null}
    </OmpDialog>
  );
}

function LoopDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const isRunning = useAppStore((state) => state.runningSessions[sessionId] === true);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 50;
  const start = async () => {
    if (pending.current || isRunning || !prompt.trim() || !validCount) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ompSessionCommand<{ loop: OmpLoop | null }>(sessionId, { type: "loop_start", prompt: prompt.trim(), count: Number(count) });
      if (!result || !("loop" in result)) throw new Error(t("chat.ompActions.actionFailed"));
      if (alive.current) onClose();
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <OmpDialog title={t("chat.ompActions.loopTitle")} icon={<IconRefresh size={15} />} className="omp-loop-dialog" onClose={() => { if (!pending.current) onClose(); }}>
      <p className="omp-muted">{t("chat.ompActions.loopHint")}</p>
      {isRunning ? <p className="omp-muted">{t("chat.ompActions.actionBusy")}</p> : null}
      <form className="omp-login-step" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <Textarea className="omp-login-input" rows={3} autoFocus value={prompt} disabled={busy} aria-label={t("chat.ompActions.loopPlaceholder")} placeholder={t("chat.ompActions.loopPlaceholder")} onChange={(event) => setPrompt(event.target.value)} />
        <div className="omp-login-row">
          <label className="omp-muted" htmlFor="omp-loop-count">{t("chat.ompActions.loopCount")}</label>
          <Input id="omp-loop-count" className="omp-loop-count" type="number" min={1} max={50} step={1} disabled={busy} value={count} onChange={(event) => setCount(event.target.value)} />
          <Button type="submit" size="sm" disabled={busy || isRunning || !prompt.trim() || !validCount}>{t("chat.ompActions.loopStart")}</Button>
        </div>
      </form>
      {error ? <div className="omp-error" role="alert">{error}</div> : null}
    </OmpDialog>
  );
}

function HandoffDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const isRunning = useAppStore((state) => state.runningSessions[sessionId] === true);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (pending.current || useAppStore.getState().runningSessions[sessionId]) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await runHandoff({ sessionId, instructions, command: api.ompSessionCommand,
        failureMessage: t("chat.ompActions.actionFailed"),
        isCurrent: () => alive.current && useAppStore.getState().activeSessionId === sessionId,
        refreshSessions: () => useAppStore.getState().refreshSessions(),
        selectSession: (id) => useAppStore.getState().selectSession(id),
      });
      if (result === "completed") {
        useAppStore.getState().showToast(t("chat.ompActions.handoffDone"), { variant: "success" });
        onClose();
      } else if (result === "cancelled" && alive.current) setError(t("chat.ompActions.handoffCancelled"));
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <OmpDialog title={t("chat.ompActions.handoffTitle")} className="omp-handoff-dialog" onClose={() => { if (!pending.current) onClose(); }} footer={<>
      <Button type="button" size="sm" disabled={busy} onClick={onClose}><IconClose size={12} /> {t("common.cancel")}</Button>
      <Button type="button" size="sm" disabled={busy || isRunning} onClick={() => void run()}>{busy ? t("common.loading") : t("chat.ompActions.handoffRun")}</Button>
    </>}>
      <p className="omp-muted">{t("chat.ompActions.handoffHint")}</p>
      {isRunning ? <p className="omp-muted">{t("chat.ompActions.actionBusy")}</p> : null}
      <Textarea className="omp-login-input" rows={3} disabled={busy} value={instructions} aria-label={t("chat.ompActions.handoffPlaceholder")} placeholder={t("chat.ompActions.handoffPlaceholder")} onChange={(event) => setInstructions(event.target.value)} />
      {error ? <div className="omp-error" role="alert">{error}</div> : null}
    </OmpDialog>
  );
}
