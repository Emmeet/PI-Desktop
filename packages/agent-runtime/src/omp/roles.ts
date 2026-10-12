import { execFile } from "node:child_process";
import { dirname, delimiter } from "node:path";
import { resolveOmpBinary } from "./binary.js";

/**
 * omp model roles (`modelRoles` in ~/.omp/agent/config.yml): named slots such as
 * default / smol / slow / plan that map to a `provider/model`. The app never
 * edits config.yml itself; it goes through `omp config get|set modelRoles`.
 */
export const OMP_BUILTIN_ROLES: { id: string; name: string }[] = [
  { id: "default", name: "Default" },
  { id: "smol", name: "Fast" },
  { id: "slow", name: "Thinking" },
  { id: "vision", name: "Vision" },
  { id: "plan", name: "Architect" },
  { id: "commit", name: "Commit" },
  { id: "tiny", name: "Tiny" },
  { id: "memory", name: "Memory" },
  { id: "task", name: "Subtask" },
  { id: "advisor", name: "Advisor" },
];

export type OmpRole = { id: string; name: string; builtin: boolean; model: string | null };

const ROLE_NAME = /^[a-zA-Z][\w-]*$/;
const MODEL_REF = /^[^\s/]+\/\S+$/;

function runOmpConfig(args: string[]): Promise<string> {
  const bin = resolveOmpBinary();
  const env = { ...process.env, PATH: `${dirname(bin)}${delimiter}${process.env.PATH ?? ""}` };
  return new Promise((resolve, reject) => {
    execFile(bin, ["config", ...args], { env, timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`omp config ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

async function readAssignments(): Promise<Record<string, string>> {
  const out = JSON.parse(await runOmpConfig(["get", "modelRoles", "--json"])) as { value?: unknown };
  const value = out.value && typeof out.value === "object" ? (out.value as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

export async function listOmpRoles(): Promise<OmpRole[]> {
  const assigned = await readAssignments();
  const roles: OmpRole[] = OMP_BUILTIN_ROLES.map((r) => ({ ...r, builtin: true, model: assigned[r.id] ?? null }));
  for (const [id, model] of Object.entries(assigned)) {
    if (!roles.some((r) => r.id === id)) roles.push({ id, name: id, builtin: false, model });
  }
  return roles;
}

/** Create, edit (model = "provider/id") or clear/delete (model = null) one role. */
export async function setOmpRole(id: string, model: string | null): Promise<OmpRole[]> {
  if (!ROLE_NAME.test(id)) throw new Error("Role names start with a letter and use letters, digits, - or _.");
  if (model !== null && !MODEL_REF.test(model)) throw new Error("Model must look like provider/model-id.");
  const assigned = await readAssignments();
  if (model === null) delete assigned[id];
  else assigned[id] = model;
  await runOmpConfig(["set", "modelRoles", JSON.stringify(assigned)]);
  return listOmpRoles();
}
