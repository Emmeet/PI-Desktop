import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";

export const OMP_INSTALL_HINT =
  "Install oh-my-pi with `bun install -g @oh-my-pi/pi-coding-agent` (needs Bun: https://bun.sh), " +
  "or set PI_DESKTOP_OMP_BIN to the full path of the `omp` executable, then restart the app.";

export class OmpNotFoundError extends Error {
  readonly errorCode = "OMP_NOT_FOUND";
  constructor(searched: string[]) {
    super(`The omp (oh-my-pi) executable was not found. ${OMP_INSTALL_HINT} Searched: ${searched.join(", ") || "(nothing)"}`);
  }
}

/** Desktop speaks protocol v1 of the tested OMP 18 release line only. */
export const OMP_SUPPORTED_VERSION_RANGE = ">=18.10.0 <19.0.0";
const OMP_COMPATIBILITY_HINT = `Use omp ${OMP_SUPPORTED_VERSION_RANGE}: bun install -g @oh-my-pi/pi-coding-agent@18, or set PI_DESKTOP_OMP_BIN to a compatible executable, then restart the app.`;

export class OmpCompatibilityError extends Error {
  constructor(readonly errorCode: "OMP_VERSION_PROBE_FAILED" | "OMP_VERSION_UNSUPPORTED" | "OMP_PROTOCOL_UNSUPPORTED", message: string) {
    super(`${message} ${OMP_COMPATIBILITY_HINT}`);
  }
}

export function parseOmpVersion(output: string): string | undefined {
  const match = /^(?:omp[ /]|oh-my-pi[ /])?v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(output.trim());
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

const compatibleBinaries = new Map<string, { stamp: string; version: string }>();

/** Probe without loading credentials/config into Desktop or leaking subprocess output. */
export function assertOmpBinaryCompatible(binary: string, env: NodeJS.ProcessEnv = process.env): string {
  let stamp: string;
  try {
    const stat = statSync(binary);
    stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    throw new OmpNotFoundError([binary]);
  }
  const cached = compatibleBinaries.get(binary);
  if (cached?.stamp === stamp) return cached.version;
  const windowsShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  const result = spawnSync(windowsShim ? `"${binary}"` : binary, ["--version"], {
    env: { ...env, PATH: [dirname(binary), env.PATH ?? env.Path ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : delimiter) },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4096,
    windowsHide: true,
    ...(windowsShim ? { shell: true } : {}),
  });
  if (result.error || result.status !== 0) {
    throw new OmpCompatibilityError("OMP_VERSION_PROBE_FAILED", "Could not run omp --version. Check the executable path and that Bun is installed.");
  }
  const version = parseOmpVersion(result.stdout);
  if (!version) throw new OmpCompatibilityError("OMP_VERSION_PROBE_FAILED", "omp --version did not return a recognized stable version.");
  const [major, minor] = version.split(".").map(Number);
  if (major !== 18 || minor! < 10) throw new OmpCompatibilityError("OMP_VERSION_UNSUPPORTED", `Unsupported omp version ${version}.`);
  compatibleBinaries.set(binary, { stamp, version });
  return version;
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
export function resolveOmpBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.PI_DESKTOP_OMP_BIN?.trim();
  if (override) {
    if (isExecutable(override)) return override;
    throw new OmpNotFoundError([override]);
  }
  const windows = platform === "win32";
  // On Windows the extensionless `omp` npm writes is a POSIX shell script that
  // cannot be spawned, so only the .exe (Bun) and .cmd (npm/pnpm) shims count.
  const names = windows ? ["omp.exe", "omp.cmd"] : ["omp"];
  const home = (windows ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || homedir();
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = windows
    ? [
        ...pathValue.split(";").filter(Boolean),
        win32.join(env.BUN_INSTALL || win32.join(home, ".bun"), "bin"),
        ...(env.APPDATA ? [win32.join(env.APPDATA, "npm")] : []),
        ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "pnpm"), win32.join(env.LOCALAPPDATA, "Programs", "omp")] : []),
      ]
    : [
        ...pathValue.split(delimiter).filter(Boolean),
        join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
        join(home, ".local", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
      ];
  const searched: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = windows ? win32.join(dir, name) : join(dir, name);
      if (searched.includes(candidate)) continue;
      searched.push(candidate);
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new OmpNotFoundError(searched);
}
