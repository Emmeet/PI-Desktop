/**
 * Projects the Settings → Skills / MCP / Subagents registries onto the
 * locations omp (oh-my-pi) actually reads, so changes made in the app take
 * effect in omp sessions (new sessions; a running omp process keeps the
 * capabilities it started with).
 *
 * - Skills: folder skills (`<id>/SKILL.md`) in `~/.agents/skills` and
 *   `<project>/.agents/skills` are discovered by omp natively; switched-off
 *   ones go to omp's `skills.ignoredSkills`. Single-file skills (`<id>.md`,
 *   what the editor creates) are mirrored as `~/.omp/agent/skills/<id>/SKILL.md`
 *   (or `<project>/.omp/skills/...`) while enabled.
 * - MCP: enabled servers are written into `~/.omp/agent/mcp.json`
 *   (`mcpServers`); servers active only in some projects go to that project's
 *   `.omp/mcp.json`.
 * - Subagents: enabled definitions are written as omp agent files into
 *   `~/.omp/agent/agents/` (or `<project>/.omp/agents/` when scoped to projects).
 *
 * Only entries this module wrote (tracked in a manifest under the app data
 * dir) are ever replaced or removed; the user's own omp config is preserved.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerRecord, UserSkillRecord, UserSubagentRecord } from "@pi-desktop/shared";

type HostLike = { call<T = unknown>(method: string, params?: unknown): Promise<T>; isAvailable?: () => boolean };

type Manifest = {
  userMcp: string[];
  projectMcp: Record<string, string[]>;
  userAgents: string[];
  projectAgents: Record<string, string[]>;
  userSkills: string[];
  projectSkills: Record<string, string[]>;
  ignoredSkills: string[];
};

const EMPTY: Manifest = { userMcp: [], projectMcp: {}, userAgents: [], projectAgents: {}, userSkills: [], projectSkills: {}, ignoredSkills: [] };

export function ompAgentDir(): string {
  const configured = process.env.PI_DESKTOP_OMP_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), ".omp", "agent");
}

function ompBinary(): string {
  const override = process.env.PI_DESKTOP_OMP_BIN?.trim();
  if (override) return override;
  const bun = join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin", process.platform === "win32" ? "omp.exe" : "omp");
  return existsSync(bun) ? bun : "omp";
}

function runOmpConfig(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ompBinary(), ["config", ...args], { timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`omp config ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** omp server entry for a desktop MCP record. */
export function ompMcpEntry(record: McpServerRecord): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (record.transport === "stdio") {
    entry.type = "stdio";
    entry.command = record.command ?? "";
    if (record.args?.length) entry.args = record.args;
    if (record.env && Object.keys(record.env).length) entry.env = record.env;
  } else {
    entry.type = "http";
    entry.url = record.url ?? "";
    if (record.headers && Object.keys(record.headers).length) entry.headers = record.headers;
  }
  if (record.timeoutSeconds) entry.timeout = record.timeoutSeconds * 1000;
  return entry;
}

/** omp's server-name pattern; desktop ids are slugs so this is normally a no-op. */
function ompServerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 100) || "server";
}

function syncMcpFile(path: string, servers: McpServerRecord[], previous: string[]): string[] {
  if (servers.length === 0 && previous.length === 0) return [];
  const file = readJson<Record<string, unknown>>(path, {});
  if (!existsSync(path) && servers.length === 0) return [];
  const map = { ...((file.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  for (const name of previous) delete map[name];
  const names: string[] = [];
  for (const server of servers) {
    const name = ompServerName(server.id);
    // Never clobber a server the user configured in omp themselves.
    if (map[name] !== undefined && !previous.includes(name)) continue;
    map[name] = ompMcpEntry(server);
    names.push(name);
  }
  writeAtomic(path, `${JSON.stringify({ ...file, mcpServers: map }, null, 2)}\n`);
  return names;
}

function frontMatter(document: string): { fields: Map<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(document);
  const fields = new Map<string, string>();
  if (!match) return { fields, body: document };
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return { fields, body: match[2] };
}

/** omp agent document for a desktop subagent record. */
export function ompAgentDocument(record: UserSubagentRecord, document: string): string {
  const { body } = frontMatter(document);
  const lines = ["---", `name: ${record.name}`, `description: ${JSON.stringify(record.description.replace(/\n/g, " "))}`];
  const tools = record.tools.filter((tool) => tool.toLowerCase() !== "inherit");
  // `inherit` means "the parent's catalog", which is omp's default when tools is omitted.
  if (tools.length && !record.tools.some((tool) => tool.toLowerCase() === "inherit")) {
    lines.push(`tools: ${tools.map((tool) => tool.toLowerCase()).join(", ")}`);
  }
  if (record.model) lines.push(`model: ${record.model}`);
  if (record.thinkingLevel) lines.push(`thinkingLevel: ${record.thinkingLevel}`);
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function syncAgentDir(dir: string, records: UserSubagentRecord[], previous: string[]): string[] {
  for (const file of previous) rmSync(join(dir, file), { force: true });
  const files: string[] = [];
  for (const record of records) {
    const file = `${record.id}.md`;
    const target = join(dir, file);
    // Leave an agent file the user wrote for omp directly alone.
    if (existsSync(target) && !previous.includes(file)) continue;
    let document = "";
    try {
      document = readFileSync(record.path, "utf8");
    } catch {
      continue;
    }
    writeAtomic(target, ompAgentDocument(record, document));
    files.push(file);
  }
  return files;
}

/** A skill stored as a single `<id>.md` file; omp only discovers `<dir>/SKILL.md`. */
function isFlatSkill(record: UserSkillRecord): boolean {
  return !/[\\/]SKILL\.md$/i.test(record.path);
}

function syncSkillDir(dir: string, records: UserSkillRecord[], previous: string[]): string[] {
  for (const id of previous) rmSync(join(dir, id), { recursive: true, force: true });
  const ids: string[] = [];
  for (const record of records) {
    const target = join(dir, record.id);
    // Leave a skill the user installed for omp directly alone.
    if (existsSync(target) && !previous.includes(record.id)) continue;
    let document = "";
    try {
      document = readFileSync(record.path, "utf8");
    } catch {
      continue;
    }
    writeAtomic(join(target, "SKILL.md"), document);
    ids.push(record.id);
  }
  return ids;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type OmpCapabilitySyncOptions = { dataDir: string; agentDir?: string; log?: (message: string, data?: unknown) => void };

/** Run one full projection. Safe to call repeatedly. */
export async function syncOmpCapabilities(host: HostLike, options: OmpCapabilitySyncOptions): Promise<void> {
  if (host.isAvailable && !host.isAvailable()) return;
  const agentDir = options.agentDir ?? ompAgentDir();
  const manifestPath = join(options.dataDir, "omp-capability-sync.json");
  const previous: Manifest = { ...EMPTY, ...readJson<Partial<Manifest>>(manifestPath, {}) };
  const next: Manifest = { ...EMPTY, projectMcp: {}, projectAgents: {}, projectSkills: {} };

  const projects = ((await host.call<{ projects?: Array<{ path?: string }> }>("projects.list").catch(() => ({ projects: [] }))).projects ?? [])
    .map((project) => project.path)
    .filter((path): path is string => typeof path === "string" && isDirectory(path));

  // --- MCP ---------------------------------------------------------------
  const globalMcp = (await host.call<{ servers?: McpServerRecord[] }>("mcp.active", { projectPath: null })).servers ?? [];
  const globalIds = new Set(globalMcp.map((server) => server.id));
  next.userMcp = syncMcpFile(join(agentDir, "mcp.json"), globalMcp, previous.userMcp);
  const mcpProjects = new Set([...projects, ...Object.keys(previous.projectMcp)]);
  for (const project of mcpProjects) {
    const active = isDirectory(project)
      ? ((await host.call<{ servers?: McpServerRecord[] }>("mcp.active", { projectPath: project }).catch(() => ({ servers: [] }))).servers ?? [])
      : [];
    const only = active.filter((server) => !globalIds.has(server.id));
    const names = syncMcpFile(join(project, ".omp", "mcp.json"), only, previous.projectMcp[project] ?? []);
    if (names.length) next.projectMcp[project] = names;
  }

  // --- Subagents ---------------------------------------------------------
  const globalAgents = (await host.call<{ subagents?: UserSubagentRecord[] }>("agents.active", { projectPath: null })).subagents ?? [];
  const globalAgentIds = new Set(globalAgents.map((agent) => agent.id));
  next.userAgents = syncAgentDir(join(agentDir, "agents"), globalAgents, previous.userAgents);
  const agentProjects = new Set([...projects, ...Object.keys(previous.projectAgents)]);
  for (const project of agentProjects) {
    const active = isDirectory(project)
      ? ((await host.call<{ subagents?: UserSubagentRecord[] }>("agents.active", { projectPath: project }).catch(() => ({ subagents: [] }))).subagents ?? [])
      : [];
    const only = active.filter((agent) => !globalAgentIds.has(agent.id));
    const files = syncAgentDir(join(project, ".omp", "agents"), only, previous.projectAgents[project] ?? []);
    if (files.length) next.projectAgents[project] = files;
  }

  // --- Skills ------------------------------------------------------------
  // Single-file skills are mirrored as `<id>/SKILL.md` where they apply;
  // folder skills already sit where omp looks, so switching one off goes
  // through omp's `skills.ignoredSkills` instead.
  const globalSkills = (await host.call<{ skills?: UserSkillRecord[] }>("skills.active", { projectPath: null })).skills ?? [];
  const globalSkillIds = new Set(globalSkills.map((skill) => skill.id));
  next.userSkills = syncSkillDir(join(agentDir, "skills"), globalSkills.filter(isFlatSkill), previous.userSkills);
  const skillProjects = new Set([...projects, ...Object.keys(previous.projectSkills)]);
  for (const project of skillProjects) {
    const active = isDirectory(project)
      ? ((await host.call<{ skills?: UserSkillRecord[] }>("skills.active", { projectPath: project }).catch(() => ({ skills: [] }))).skills ?? [])
      : [];
    const only = active.filter((skill) => isFlatSkill(skill) && !globalSkillIds.has(skill.id));
    const ids = syncSkillDir(join(project, ".omp", "skills"), only, previous.projectSkills[project] ?? []);
    if (ids.length) next.projectSkills[project] = ids;
  }
  const listed: UserSkillRecord[] = [
    ...((await host.call<{ skills?: UserSkillRecord[] }>("skills.list", { level: "global" })).skills ?? []),
  ];
  for (const project of projects) {
    listed.push(
      ...((await host.call<{ skills?: UserSkillRecord[] }>("skills.list", { level: "project", projectPath: project }).catch(() => ({ skills: [] }))).skills ?? []),
    );
  }
  const disabled = [...new Set(listed.filter((skill) => !skill.enabled && !isFlatSkill(skill)).map((skill) => skill.name))].sort();
  const before = [...previous.ignoredSkills].sort();
  const same = disabled.length === before.length && disabled.every((name, i) => name === before[i]);
  if (!same) {
    try {
      const current = JSON.parse(await runOmpConfig(["get", "skills.ignoredSkills", "--json"])) as { value?: unknown };
      const values = Array.isArray(current.value) ? current.value.filter((v): v is string => typeof v === "string") : [];
      const kept = values.filter((name) => !previous.ignoredSkills.includes(name));
      await runOmpConfig(["set", "skills.ignoredSkills", JSON.stringify([...new Set([...kept, ...disabled])])]);
      next.ignoredSkills = disabled;
    } catch (error) {
      options.log?.("omp skills ignore sync failed", String(error));
      next.ignoredSkills = previous.ignoredSkills;
    }
  } else {
    next.ignoredSkills = previous.ignoredSkills;
  }

  writeAtomic(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

/** Debounced runner: coalesces bursts of settings changes into one projection. */
export function createOmpCapabilitySync(getHost: () => HostLike | null, options: OmpCapabilitySyncOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    running = running
      .then(async () => {
        const host = getHost();
        if (host) await syncOmpCapabilities(host, options);
      })
      .catch((error) => options.log?.("omp capability sync failed", String(error)));
    return running;
  };
  return {
    schedule(delayMs = 300) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
    },
    run,
  };
}
