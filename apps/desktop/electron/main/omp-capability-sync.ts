/**
 * Projects the Settings → Skills / MCP / Subagents registries onto the
 * locations omp (oh-my-pi) actually reads, so changes made in the app take
 * effect in omp sessions (new sessions; a running omp process keeps the
 * capabilities it started with).
 *
 * - Skills: omp's scan of `~/.agents/skills` (the app's registry) is turned
 *   off and each enabled skill is mirrored by scope: `~/.omp/agent/skills/<id>`
 *   for global, `<project>/.omp/skills/<id>` for project-scoped (folder skills
 *   are symlinked, single-file skills copied as SKILL.md). Project-level folder
 *   skills stay with omp's native `<project>/.agents/skills` scan; switching
 *   one off adds it to that project's `.omp/settings.json` `skills.ignoredSkills`.
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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  projectIgnored?: Record<string, string[]>;
  agentsUserScanOff?: boolean;
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

/** App tool names that differ from omp's. */
const OMP_TOOL_NAMES: Record<string, string> = { browserpreview: "browser" };

/** omp agent document for a desktop subagent record. */
export function ompAgentDocument(record: UserSubagentRecord, document: string): string {
  const { body } = frontMatter(document);
  const lines = ["---", `name: ${record.name}`, `description: ${JSON.stringify(record.description.replace(/\n/g, " "))}`];
  const tools = record.tools.filter((tool) => tool.toLowerCase() !== "inherit");
  // `inherit` means "the parent's catalog", which is omp's default when tools is omitted.
  if (tools.length && !record.tools.some((tool) => tool.toLowerCase() === "inherit")) {
    const names = tools.map((tool) => OMP_TOOL_NAMES[tool.toLowerCase()] ?? tool.toLowerCase());
    lines.push(`tools: ${[...new Set(names)].join(", ")}`);
  }
  // Quoted: `@role` is not a valid plain YAML scalar.
  if (record.model) lines.push(`model: ${JSON.stringify(record.model)}`);
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
    try {
      if (isFlatSkill(record)) {
        writeAtomic(join(target, "SKILL.md"), readFileSync(record.path, "utf8"));
      } else {
        // Folder skills keep their scripts/resources: link the whole folder.
        mkdirSync(dir, { recursive: true });
        symlinkSync(dirname(record.path), target, "dir");
      }
    } catch {
      continue;
    }
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
  // The app owns `~/.agents/skills`, so omp's own scan of it is turned off and
  // every skill is mirrored where its scope says: global ones into
  // `~/.omp/agent/skills`, project-scoped ones into `<project>/.omp/skills`.
  // Project-level folder skills (`<project>/.agents/skills`) stay with omp's
  // native project scan.
  if (!previous.agentsUserScanOff) {
    try {
      await runOmpConfig(["set", "skills.enableAgentsUser", "false"]);
      next.agentsUserScanOff = true;
    } catch (error) {
      options.log?.("omp skills scan setting failed", String(error));
    }
  } else {
    next.agentsUserScanOff = true;
  }
  const nativeProjectSkill = (skill: UserSkillRecord) => skill.level === "project" && !isFlatSkill(skill);
  const globalSkills = ((await host.call<{ skills?: UserSkillRecord[] }>("skills.active", { projectPath: null })).skills ?? []).filter(
    (skill) => !nativeProjectSkill(skill),
  );
  const globalSkillIds = new Set(globalSkills.map((skill) => skill.id));
  next.userSkills = syncSkillDir(join(agentDir, "skills"), globalSkills, previous.userSkills);
  const skillProjects = new Set([...projects, ...Object.keys(previous.projectSkills)]);
  for (const project of skillProjects) {
    const active = isDirectory(project)
      ? ((await host.call<{ skills?: UserSkillRecord[] }>("skills.active", { projectPath: project }).catch(() => ({ skills: [] }))).skills ?? [])
      : [];
    const only = active.filter((skill) => !nativeProjectSkill(skill) && !globalSkillIds.has(skill.id));
    const ids = syncSkillDir(join(project, ".omp", "skills"), only, previous.projectSkills[project] ?? []);
    if (ids.length) next.projectSkills[project] = ids;
  }
  // A switched-off project-level folder skill is hidden in that project only,
  // through the project's own omp settings (`<project>/.omp/settings.json`).
  // omp replaces arrays across layers, so the user's global ignore list is
  // carried into the project list.
  let globalIgnored: string[] = [];
  try {
    const current = JSON.parse(await runOmpConfig(["get", "skills.ignoredSkills", "--json"])) as { value?: unknown };
    globalIgnored = Array.isArray(current.value) ? current.value.filter((v): v is string => typeof v === "string") : [];
    // Earlier builds wrote switched-off skills into the global list; take them back out.
    if (previous.ignoredSkills.length) {
      globalIgnored = globalIgnored.filter((name) => !previous.ignoredSkills.includes(name));
      await runOmpConfig(["set", "skills.ignoredSkills", JSON.stringify(globalIgnored)]);
    }
  } catch (error) {
    options.log?.("omp skills ignore read failed", String(error));
  }
  next.ignoredSkills = [];
  next.projectIgnored = {};
  const ignoreProjects = new Set([...projects, ...Object.keys(previous.projectIgnored ?? {})]);
  for (const project of ignoreProjects) {
    const listedHere = isDirectory(project)
      ? ((await host.call<{ skills?: UserSkillRecord[] }>("skills.list", { level: "project", projectPath: project }).catch(() => ({ skills: [] }))).skills ?? [])
      : [];
    const off = [...new Set(listedHere.filter((skill) => !skill.enabled && nativeProjectSkill(skill)).map((skill) => skill.name))].sort();
    const had = previous.projectIgnored?.[project];
    if (!off.length && !had) continue;
    const path = join(project, ".omp", "settings.json");
    const file = readJson<Record<string, unknown>>(path, {});
    const skills = { ...((file.skills as Record<string, unknown> | undefined) ?? {}) };
    if (off.length) {
      skills.ignoredSkills = [...new Set([...globalIgnored, ...off])];
      next.projectIgnored[project] = off;
    } else {
      delete skills.ignoredSkills;
    }
    const updated: Record<string, unknown> = { ...file, skills };
    if (!Object.keys(skills).length) delete updated.skills;
    if (!Object.keys(updated).length) rmSync(path, { force: true });
    else writeAtomic(path, `${JSON.stringify(updated, null, 2)}\n`);
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

// --- omp's own agents (Settings → Subagents) ---------------------------------

export type OmpAgentRow = {
  name: string;
  description: string;
  tools?: string[];
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  source: "builtin";
  /** Where omp finds it: bundled with omp, `~/.omp/agent/agents`, or `<project>/.omp/agents`. */
  origin: "bundled" | "user" | "project";
  enabled: boolean;
};

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Minimal frontmatter reader: scalars, inline `[a, b]` lists and `- item` lists. */
export function parseOmpAgentFile(text: string): { fields: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields: Record<string, string | string[]> = {};
  if (!match) return { fields, body: text };
  let listKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      (fields[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (!raw.trim()) {
      fields[key] = [];
      listKey = key;
    } else if (raw.trim().startsWith("[")) {
      fields[key] = raw.trim().slice(1, -1).split(",").map(unquote).filter(Boolean);
      listKey = null;
    } else {
      fields[key] = unquote(raw);
      listKey = null;
    }
  }
  return { fields, body: match[2].trim() };
}

function rowFromFile(text: string, origin: OmpAgentRow["origin"], disabled: Set<string>): OmpAgentRow | null {
  const { fields, body } = parseOmpAgentFile(text);
  const name = typeof fields.name === "string" ? fields.name : "";
  if (!name) return null;
  const tools = Array.isArray(fields.tools) ? fields.tools : typeof fields.tools === "string" ? fields.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  return {
    name,
    description: typeof fields.description === "string" ? fields.description : "",
    ...(tools?.length ? { tools } : {}),
    prompt: body,
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(typeof fields.thinkingLevel === "string" ? { thinkingLevel: fields.thinkingLevel } : {}),
    source: "builtin",
    origin,
    enabled: !disabled.has(name),
  };
}

let bundledCache: string[] | null = null;

/** omp's bundled agent documents, exported once per app run via `omp agents unpack`. */
async function bundledAgentDocuments(dataDir: string): Promise<string[]> {
  if (bundledCache) return bundledCache;
  const dir = join(dataDir, "omp-bundled-agents");
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    execFile(ompBinary(), ["agents", "unpack", "--dir", dir, "--force", "--json"], { timeout: 30_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  const { readdirSync } = await import("node:fs");
  bundledCache = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"));
  return bundledCache;
}

async function disabledAgents(): Promise<string[]> {
  const out = JSON.parse(await runOmpConfig(["get", "task.disabledAgents", "--json"])) as { value?: unknown };
  return Array.isArray(out.value) ? out.value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * omp's real agent catalog: bundled agents plus the user's and the open
 * project's own omp agent files (excluding the ones this app writes from
 * Settings, which the page already lists as the user's).
 */
export async function ompAgentCatalog(options: OmpCapabilitySyncOptions & { projectPath?: string | null }): Promise<OmpAgentRow[]> {
  const agentDir = options.agentDir ?? ompAgentDir();
  const manifest: Manifest = { ...EMPTY, ...readJson<Partial<Manifest>>(join(options.dataDir, "omp-capability-sync.json"), {}) };
  const disabled = new Set(await disabledAgents().catch(() => []));
  const rows = new Map<string, OmpAgentRow>();
  for (const text of await bundledAgentDocuments(options.dataDir).catch(() => [])) {
    const row = rowFromFile(text, "bundled", disabled);
    if (row) rows.set(row.name, row);
  }
  const { readdirSync } = await import("node:fs");
  const scan = (dir: string, managed: string[], origin: OmpAgentRow["origin"]) => {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".md") && !managed.includes(file));
    } catch {
      return;
    }
    for (const file of files.sort()) {
      try {
        const row = rowFromFile(readFileSync(join(dir, file), "utf8"), origin, disabled);
        if (row) rows.set(row.name, row);
      } catch {
        /* unreadable file: skip */
      }
    }
  };
  scan(join(agentDir, "agents"), manifest.userAgents, "user");
  if (options.projectPath) scan(join(options.projectPath, ".omp", "agents"), manifest.projectAgents[options.projectPath] ?? [], "project");
  return [...rows.values()];
}

/** Switch one omp agent on/off through omp's `task.disabledAgents`, keeping the user's other entries. */
export async function setOmpAgentEnabled(name: string, enabled: boolean): Promise<void> {
  const current = await disabledAgents();
  const next = enabled ? current.filter((entry) => entry !== name) : [...new Set([...current, name])];
  await runOmpConfig(["set", "task.disabledAgents", JSON.stringify(next)]);
}
