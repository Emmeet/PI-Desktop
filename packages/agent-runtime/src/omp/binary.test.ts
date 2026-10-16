import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOmpBinaryCompatible, OMP_SUPPORTED_VERSION_RANGE, parseOmpVersion, resolveOmpBinary } from "./binary.js";
import { OmpRpcProcess } from "./rpc-process.js";

const roots: string[] = [];
const processes: OmpRpcProcess[] = [];
afterEach(() => {
  for (const process of processes.splice(0)) process.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(source: string): { binary: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "omp binary "));
  roots.push(root);
  const script = join(root, "engine.cjs");
  writeFileSync(script, source);
  const binary = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  writeFileSync(binary, process.platform === "win32" ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  return { binary, root };
}

describe("omp binary compatibility", () => {
  it("accepts stable 18.10 and later 18.x versions within an explicit major bound", () => {
    expect(OMP_SUPPORTED_VERSION_RANGE).toBe(">=18.10.0 <19.0.0");
    for (const output of ["18.10.0", "omp/18.10.9", "omp 18.11.0", "v18.12.3+build.1"]) {
      const { binary } = executable(`process.stdout.write(${JSON.stringify(output)});`);
      expect(assertOmpBinaryCompatible(binary)).toBe(parseOmpVersion(output));
    }
  });

  it.each(["17.99.0", "18.9.99", "19.0.0", "20.1.0"])("rejects unsupported version %s with an actionable hint", (version) => {
    const { binary } = executable(`process.stdout.write(${JSON.stringify(version)});`);
    expect(() => assertOmpBinaryCompatible(binary)).toThrow(expect.objectContaining({ errorCode: "OMP_VERSION_UNSUPPORTED", message: expect.stringContaining("PI_DESKTOP_OMP_BIN") }));
  });

  it.each(["18.10.0-rc.1", "not a version", "", "18.10"])("rejects unrecognized version output %s", (version) => {
    const { binary } = executable(`process.stdout.write(${JSON.stringify(version)});`);
    expect(() => assertOmpBinaryCompatible(binary)).toThrow(expect.objectContaining({ errorCode: "OMP_VERSION_PROBE_FAILED", message: expect.stringContaining("bun install -g") }));
  });

  it("handles missing executables and failing probes without leaking stderr", () => {
    expect(() => resolveOmpBinary({ PI_DESKTOP_OMP_BIN: join(tmpdir(), "missing-omp-binary") })).toThrow(expect.objectContaining({ errorCode: "OMP_NOT_FOUND" }));
    const { binary } = executable('process.stderr.write("PRIVATE_TOKEN"); process.exit(2);');
    let failure: unknown;
    try { assertOmpBinaryCompatible(binary); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ errorCode: "OMP_VERSION_PROBE_FAILED" });
    expect(String(failure)).not.toContain("PRIVATE_TOKEN");
  });


  it.each([2, undefined, "1"])("rejects unsupported or absent RPC protocol %s before commands", async (protocolVersion) => {
    const source = `if (process.argv.includes("--version")) { console.log("18.10.0"); process.exit(0); }
console.log(JSON.stringify({ type: "ready", protocolVersion: ${JSON.stringify(protocolVersion)} }));
process.stdin.resume();`;
    const { binary, root } = executable(source);
    const rpc = new OmpRpcProcess(binary, [], { cwd: root }); processes.push(rpc);
    await expect(rpc.ready).rejects.toMatchObject({ errorCode: "OMP_PROTOCOL_UNSUPPORTED", message: expect.stringContaining("18.10.0") });
    expect(rpc.isAlive).toBe(false);
    await expect(rpc.request({ type: "get_state" })).rejects.toMatchObject({ errorCode: "OMP_PROCESS_EXITED" });
  });
});
