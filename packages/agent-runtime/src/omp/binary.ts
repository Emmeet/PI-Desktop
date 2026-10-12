import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const OMP_INSTALL_HINT =
  "Install oh-my-pi with `bun install -g @oh-my-pi/pi-coding-agent` (needs Bun: https://bun.sh), " +
  "or set PI_DESKTOP_OMP_BIN to the full path of the `omp` executable, then restart the app.";

export class OmpNotFoundError extends Error {
  readonly errorCode = "OMP_NOT_FOUND";
  constructor(searched: string[]) {
    super(`The omp (oh-my-pi) executable was not found. ${OMP_INSTALL_HINT} Searched: ${searched.join(", ") || "(nothing)"}`);
  }
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the `omp` executable. Order: PI_DESKTOP_OMP_BIN, then PATH, then the
 * usual Bun / npm global bin directories (GUI launches often have a minimal PATH).
 */
export function resolveOmpBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_DESKTOP_OMP_BIN?.trim();
  if (override) {
    if (isExecutable(override)) return override;
    throw new OmpNotFoundError([override]);
  }
  const names = process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp"] : ["omp"];
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean),
    join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
    join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  const searched: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (searched.includes(candidate)) continue;
      searched.push(candidate);
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new OmpNotFoundError(searched);
}
