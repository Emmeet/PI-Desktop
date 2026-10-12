/**
 * Task notifications for omp sessions.
 *
 * host-core's notification table is keyed to its own sessions table, which
 * omp sessions are not in, so completion/failure rows for omp turns live in a
 * small JSON store here and are merged into every notification query.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type OmpNotification = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string;
};

const KEEP = 100;

export function createOmpNotificationStore(dataDir: string) {
  const path = join(dataDir, "omp-notifications.json");
  const load = (): OmpNotification[] => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(parsed) ? (parsed as OmpNotification[]) : [];
    } catch {
      return [];
    }
  };
  const save = (rows: OmpNotification[]) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows.slice(0, KEEP)));
    renameSync(tmp, path);
  };
  return {
    add(input: Omit<OmpNotification, "id" | "createdAt">): OmpNotification | null {
      const rows = load();
      if (rows.some((row) => row.turnId === input.turnId)) return null;
      const row: OmpNotification = { ...input, id: `omp-${randomUUID()}`, createdAt: new Date().toISOString() };
      save([row, ...rows]);
      return row;
    },
    /** Merge omp rows into a host `notification.list` answer. */
    merge(
      host: { notifications?: Array<{ createdAt: string; readAt?: string }>; unreadCount?: number },
      input: { unreadOnly?: boolean; limit?: number },
    ) {
      const own = load().filter((row) => !input.unreadOnly || !row.readAt);
      const all = [...(host.notifications ?? []), ...own].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : all.length;
      return {
        ...host,
        notifications: all.slice(0, limit),
        unreadCount: (host.unreadCount ?? 0) + load().filter((row) => !row.readAt).length,
      };
    },
    owns: (id: string) => id.startsWith("omp-"),
    markRead(id: string): boolean {
      const rows = load();
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return false;
      row.readAt ??= new Date().toISOString();
      save(rows);
      return true;
    },
    markAllRead() {
      const now = new Date().toISOString();
      save(load().map((row) => ({ ...row, readAt: row.readAt ?? now })));
    },
    clear() {
      save([]);
    },
  };
}

export type OmpNotificationStore = ReturnType<typeof createOmpNotificationStore>;

/** Shared wiring between the notification IPC and the omp event stream. */
export const ompNotificationHub: {
  store: OmpNotificationStore | null;
  /** False while the user is looking at that session in a focused window. */
  shouldCreate: (sessionId: string) => boolean;
  /** omp session id → scheduled run id, for runs dispatched to omp. */
  scheduledRuns: Map<string, string>;
  /** Tells the renderer a notification was added. */
  announce: (notification: unknown) => void;
} = { store: null, shouldCreate: () => true, scheduledRuns: new Map(), announce: () => {} };
