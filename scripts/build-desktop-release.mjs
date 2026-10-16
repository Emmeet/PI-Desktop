import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import { pathToFileURL } from "node:url";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const nativeTargets = { win32: "win", darwin: "mac", linux: "linux" };

export function desktopReleaseCommands(argv, { platform = process.platform, arch = process.arch } = {}) {
  const forwardedArgs = [...argv];
  const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
    ? forwardedArgs.shift()
    : undefined;
  // pnpm run accepts an optional argument separator; it is not a builder flag.
  if (forwardedArgs[0] === "--") forwardedArgs.shift();
  const hostTarget = nativeTargets[platform];
  const target = requestedTarget ?? hostTarget;
  if (!hostTarget || target !== hostTarget) {
    throw new Error(`Build ${target ?? "desktop"} on a native ${target ?? "supported"} runner; the Rust sidecar and native dependencies cannot be cross-packaged from ${platform}.`);
  }
  if (target === "win" && arch !== "x64") {
    throw new Error("Windows desktop packages require a native Windows x64 runner.");
  }
  for (const requestedArch of ["x64", "ia32", "armv7l", "arm64", "universal"]) {
    if (forwardedArgs.includes(`--${requestedArch}`) && requestedArch !== arch) {
      throw new Error(`Cannot package ${requestedArch} with a ${arch} Rust sidecar; use a matching native runner.`);
    }
  }
  for (const otherTarget of ["win", "mac", "linux"]) {
    if (otherTarget !== target && forwardedArgs.includes(`--${otherTarget}`)) {
      throw new Error(`Cannot cross-package --${otherTarget} on this ${target} runner.`);
    }
  }
  // Remove caller publish flags instead of relying on yargs duplicate-option
  // precedence. All entrypoints using this wrapper are build-only.
  const builderArgs = [];
  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const arg = forwardedArgs[index];
    if (arg === "--publish" || arg === "-p") index += 1;
    else if (!arg.startsWith("--publish=") && !arg.startsWith("-p=")) builderArgs.push(arg);
  }

  const command = (targets, distribution) => [
    `--${target}`,
    ...targets,
    ...builderArgs,
    // The per-artifact metadata follows caller config so it cannot drift.
    "--publish", "never",
    ...(distribution ? [`-c.extraMetadata.piDistribution=${distribution}`] : []),
  ];
  return target === "win"
    ? [command(["nsis"], "installed"), command(["zip"], "zip"), command(["portable"], "portable")]
    : [command([], undefined)];
}

async function runBuilder(args) {
  // Invoke the JS CLI with Node, not a pnpm.cmd shell shim: paths containing
  // spaces and forwarded arguments must remain literal on Windows.
  const builderCli = desktopRequire.resolve("electron-builder/cli.js");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builderCli, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`electron-builder failed with ${code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const args of desktopReleaseCommands(process.argv.slice(2))) {
    await runBuilder(args);
  }
}
