import { IPC, type ScheduledTask } from "@pi-desktop/shared";
import { ompNotificationHub } from "../omp-notifications";

const OMP_ONLY = process.env.PI_DESKTOP_LEGACY_PI_ENGINE !== "1";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { executeScheduledTask } from "../runtime/scheduled-runner";

export type ScheduledIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  scheduledRunsBySession: Map<string, string>;
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  isQuitting: () => boolean;
};

export function registerScheduledIpc({
  registrar,
  getHost,
  scheduledRunsBySession,
  invoke,
  isQuitting,
}: ScheduledIpcDependencies): void {
  // The Scheduled workspace renders one task's own history and one newest run
  // per task for the column, so the caller may scope or summarize the read. The
  // host owns the 1..200 bound and the default, so the request only forwards a
  // validated shape.
  registrar.handle(
    IPC.invoke.scheduledListRuns,
    async (options: { taskId?: unknown; limit?: unknown; latestPerTask?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const taskId = typeof options?.taskId === "string" ? options.taskId.trim() : "";
      const limit = options?.limit === undefined ? undefined : options.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new Error("invalid scheduled run limit");
      }
      return host.call("scheduled.listRuns", {
        ...(options?.latestPerTask === true ? { latestPerTask: true } : {}),
        ...(taskId ? { taskId } : {}),
        ...(limit === undefined ? {} : { limit: Math.trunc(limit) }),
      });
    },
  );

  /**
   * omp is the only engine: every run opens a new omp session in the task's
   * project (omp's `default` role unless the task names a model or role), and
   * the run is closed from that session's terminal event.
   */
  const executeScheduledTaskInOmp = async (host: HostProcess, id: string, automatic: boolean) => {
    const { tasks } = await host.call<{ tasks?: ScheduledTask[] }>("scheduled.list");
    const task = (tasks ?? []).find((candidate) => candidate.id === id);
    const launch = await host.call<{ sessionId: string; prompt: string; runId: string }>("scheduled.run", { id, automatic });
    let sessionId: string | undefined;
    try {
      if (isQuitting() || getHost() !== host) throw new Error("scheduled runtime stopped");
      const created = (await invoke(IPC.invoke.sessionCreate, [
        { projectPath: task?.workspacePath ?? null, title: task?.title || undefined },
      ])) as { session?: { id?: string } };
      sessionId = created.session?.id;
      if (!sessionId) throw new Error("omp session was not created");
      if (task?.providerId && task.modelId) {
        let provider = task.providerId;
        let modelId = task.modelId;
        let level: string | undefined = task.thinkingLevel;
        if (provider === "omp-role") {
          const { roles } = (await invoke(IPC.invoke.ompRolesList, [])) as { roles: Array<{ id: string; model: string | null }> };
          const ref = roles.find((role) => role.id === modelId)?.model ?? "";
          const [pin, roleLevel] = ref.split(":");
          const slash = pin.indexOf("/");
          if (slash > 0) {
            provider = pin.slice(0, slash);
            modelId = pin.slice(slash + 1);
            level = roleLevel || level;
          } else {
            provider = "";
          }
        }
        if (provider) await invoke(IPC.invoke.ompModelSet, [{ sessionId, provider, modelId, persist: false }]);
        if (level && level !== "omit") await invoke(IPC.invoke.ompThinkingSet, [{ sessionId, level, persist: false }]);
      }
      ompNotificationHub.scheduledRuns.set(sessionId, launch.runId);
      await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: launch.prompt }]);
      return { ...launch, sessionId };
    } catch (error) {
      await host
        .call("scheduled.finishRun", { runId: launch.runId, status: "error", errorCode: "SCHEDULE_DISPATCH_FAILED" })
        .catch(() => {});
      if (sessionId) ompNotificationHub.scheduledRuns.delete(sessionId);
      const notification = ompNotificationHub.store?.add({
        kind: "task.failed",
        sessionId: sessionId ?? "",
        sessionTitle: task?.title || "Scheduled task",
        turnId: `schedule:${launch.runId}`,
        errorCode: "SCHEDULE_DISPATCH_FAILED",
      });
      if (notification) ompNotificationHub.announce(notification);
      throw error;
    }
  };
  registrar.handle(IPC.invoke.scheduledExecute, async (id: string, automatic = false) => {
    if (typeof id !== "string" || typeof automatic !== "boolean") throw new Error("invalid task request");
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    if (OMP_ONLY) return executeScheduledTaskInOmp(host, id, automatic);
    return executeScheduledTask({
      host, id, automatic, runs: scheduledRunsBySession,
      isCurrent: () => !isQuitting() && getHost() === host,
      prompt: (sessionId, content) => invoke(IPC.invoke.agentPrompt, [{ sessionId, content }]),
    });
  });
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => fn(getHost(), ...args));
  };

  handle(IPC.invoke.scheduledList, async (host: HostProcess | null) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.list");
  });
  handle(IPC.invoke.scheduledCreate, async (host: HostProcess | null, input: any = {}) => {
    if (!host) throw new Error("host unavailable");
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("prompt required");
    return host.call("scheduled.create", { ...input, prompt });
  });
  handle(IPC.invoke.scheduledUpdate, async (host: HostProcess | null, input: any = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.update", input);
  });
  handle(IPC.invoke.scheduledDelete, async (host: HostProcess | null, id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.delete", { id });
  });
  handle(IPC.invoke.scheduledRun, async (host: HostProcess | null, id: string) => {
    if (!host) throw new Error("host unavailable");
    if (OMP_ONLY) return executeScheduledTaskInOmp(host, id, false);
    const result = await host.call<{
      sessionId: string;
      prompt: string;
      task: unknown;
      runId: string;
    }>("scheduled.run", { id });
    scheduledRunsBySession.set(result.sessionId, result.runId);
    return result;
  });
}
