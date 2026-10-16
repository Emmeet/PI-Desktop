import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { desktopReleaseCommands } from "../../../scripts/build-desktop-release.mjs";
import { assertWindowsX64Pe, inspectWindowsPackage } from "../../../scripts/verify-windows-package.mjs";

const windows = { platform: "win32", arch: "x64" };

test("Windows builds all three distributions separately and cannot self-publish", () => {
  const argv = ["win", "--", "--x64", "--publish", "always", "-c.extraMetadata.piDistribution=wrong"];
  const commands = desktopReleaseCommands(argv, windows);
  assert.deepEqual(argv.slice(0, 3), ["win", "--", "--x64"], "caller arguments are not mutated");
  assert.deepEqual(commands.map((args) => args.slice(0, 2)), [["--win", "nsis"], ["--win", "zip"], ["--win", "portable"]]);
  assert.deepEqual(commands.map((args) => args.slice(-3)), [
    ["--publish", "never", "-c.extraMetadata.piDistribution=installed"],
    ["--publish", "never", "-c.extraMetadata.piDistribution=zip"],
    ["--publish", "never", "-c.extraMetadata.piDistribution=portable"],
  ]);
  for (const command of commands) assert.equal(command.includes("--"), false);
  for (const flag of [["--publish", "always"], ["--publish=always"], ["-p", "always"], ["-p=always"]]) {
    for (const command of desktopReleaseCommands(["win", ...flag], windows)) {
      assert.deepEqual(command.filter((value) => value === "--publish"), ["--publish"]);
      assert.equal(command.some((value) => value.includes("always")), false);
    }
  }
});

test("release arguments retain literal Windows paths without shell interpretation", () => {
  const value = "-c.directories.output=C:\\a path\\OMP & Desktop";
  for (const command of desktopReleaseCommands(["win", value], windows)) assert.ok(command.includes(value));
});

test("native sidecars cannot be wrapped in another platform or architecture", () => {
  assert.throws(() => desktopReleaseCommands(["win"], { platform: "linux", arch: "x64" }), /native win runner/);
  assert.throws(() => desktopReleaseCommands(["win", "--arm64"], windows), /arm64.*x64 Rust sidecar/);
  assert.throws(() => desktopReleaseCommands(["win"], { platform: "win32", arch: "arm64" }), /Windows x64 runner/);
  assert.throws(() => desktopReleaseCommands(["win", "--linux"], windows), /cross-package/);
  assert.deepEqual(desktopReleaseCommands(["--", "--arm64"], { platform: "darwin", arch: "arm64" }), [["--mac", "--arm64", "--publish", "never"]]);
  assert.deepEqual(desktopReleaseCommands([], { platform: "linux", arch: "x64" }), [["--linux", "--publish", "never"]]);
});

function peBytes(machine = 0x8664) {
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\0\0", 64);
  pe.writeUInt16LE(machine, 68);
  return pe;
}

async function writeFixtureFile(root, path, bytes) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return destination;
}

test("PE validation rejects Linux binaries, ARM64 binaries, and truncated headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-pe-test-"));
  try {
    await assertWindowsX64Pe(await writeFixtureFile(root, "host.exe", peBytes()));
    await assert.rejects(assertWindowsX64Pe(await writeFixtureFile(root, "linux.exe", Buffer.alloc(128))), /Not a Windows binary/);
    await assert.rejects(assertWindowsX64Pe(await writeFixtureFile(root, "arm.exe", peBytes(0xaa64))), /Not a Windows x64 binary/);
    await assert.rejects(assertWindowsX64Pe(await writeFixtureFile(root, "empty.exe", "")), /Truncated PE header/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package inventory requires shipped Windows native dependencies, notices, and all outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-package-test-"));
  const resources = "win-unpacked/resources";
  const modules = `${resources}/app.asar.unpacked/node_modules`;
  try {
    for (const path of [
      "win-unpacked/OMP-Desktop.exe",
      `${resources}/bin/pi-desktop-host-core.exe`,
      `${modules}/@picovoice/pvrecorder-node/lib/windows/amd64/pv_recorder.node`,
      `${modules}/@koromix/koffi-win32-x64/win32_x64/koffi.node`,
      `${modules}/@transcribe-cpp/win32-x64-cpu-vulkan/transcribe.dll`,
    ]) await writeFixtureFile(root, path, peBytes());
    // Native provider license directories are not themselves native libraries.
    await writeFixtureFile(root, `${modules}/@transcribe-cpp/win32-x64-cpu-vulkan/licenses/LICENSE`, "dependency license");
    for (const path of [
      `${resources}/LICENSE`, `${resources}/NOTICE`, `${resources}/agent-runtime/sidecar.js`,
      "OMP-Desktop-Setup-9.8.7-x64.exe", "OMP-Desktop-Portable-9.8.7-x64.exe", "OMP-Desktop-9.8.7-win-x64.zip",
    ]) await writeFixtureFile(root, path, "fixture");
    const inventory = await inspectWindowsPackage(root, "9.8.7");
    assert.equal(inventory.binaries.length, 5);
    assert.equal(inventory.artifacts.length, 3);
    await rm(join(root, resources, "NOTICE"));
    await assert.rejects(inspectWindowsPackage(root, "9.8.7"), /NOTICE/);
    await writeFixtureFile(root, `${resources}/NOTICE`, "notice");
    await rm(join(root, modules, "@transcribe-cpp/win32-x64-cpu-vulkan/transcribe.dll"));
    await assert.rejects(inspectWindowsPackage(root, "9.8.7"), /transcribe DLL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
