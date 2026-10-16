import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function assertWindowsX64Pe(path) {
  const file = await open(path, "r");
  try {
    const dos = Buffer.alloc(64);
    const { bytesRead } = await file.read(dos, 0, dos.length, 0);
    assert.equal(bytesRead, 64, `Truncated PE header: ${path}`);
    assert.equal(dos.toString("ascii", 0, 2), "MZ", `Not a Windows binary: ${path}`);
    const pe = Buffer.alloc(6);
    const result = await file.read(pe, 0, pe.length, dos.readUInt32LE(0x3c));
    assert.equal(result.bytesRead, 6, `Truncated PE signature: ${path}`);
    assert.equal(pe.toString("ascii", 0, 4), "PE\0\0", `Invalid PE signature: ${path}`);
    assert.equal(pe.readUInt16LE(4), 0x8664, `Not a Windows x64 binary: ${path}`);
  } finally {
    await file.close();
  }
}

async function nativeFiles(directory, extension) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await nativeFiles(path, extension));
    else if (entry.name.endsWith(extension)) files.push(path);
  }
  return files;
}

export async function inspectWindowsPackage(releaseDir, version) {
  const unpacked = join(releaseDir, "win-unpacked");
  const resources = join(unpacked, "resources");
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  const hostBinary = join(resources, "bin", "pi-desktop-host-core.exe");
  const binaries = [
    join(unpacked, "OMP-Desktop.exe"),
    hostBinary,
    join(modules, "@picovoice", "pvrecorder-node", "lib", "windows", "amd64", "pv_recorder.node"),
    ...await nativeFiles(join(modules, "@koromix", "koffi-win32-x64"), ".node"),
    ...await nativeFiles(join(modules, "@transcribe-cpp", "win32-x64-cpu-vulkan"), ".dll"),
  ];
  for (const binary of binaries) await assertWindowsX64Pe(binary);
  assert.ok(binaries.some((path) => path.endsWith("koffi.node")), "Missing unpacked Windows koffi addon");
  assert.ok(binaries.some((path) => path.endsWith("transcribe.dll")), "Missing unpacked Windows transcribe DLL");
  for (const name of ["LICENSE", "NOTICE"]) {
    assert.ok((await readFile(join(resources, name), "utf8")).trim(), `Missing packaged ${name}`);
  }
  assert.ok((await readFile(join(resources, "agent-runtime", "sidecar.js"))).length > 0);
  const artifacts = [
    `OMP-Desktop-Setup-${version}-x64.exe`,
    `OMP-Desktop-Portable-${version}-x64.exe`,
    `OMP-Desktop-${version}-win-x64.zip`,
  ];
  const outputs = await readdir(releaseDir);
  for (const artifact of artifacts) assert.ok(outputs.includes(artifact), `Missing ${artifact}`);
  return { hostBinary, binaries, artifacts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.platform, "win32", "Run Windows native smoke on Windows, not a cross-packaging host");
  assert.equal(process.arch, "x64", "Run Windows native smoke on x64");
  const releaseDir = resolve(process.argv[2] ?? "apps/desktop/release");
  const { version } = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
  const inventory = await inspectWindowsPackage(releaseDir, version);
  // Reuse the production protocol harness with a throwaway data directory. No
  // omp binary, provider, model, microphone, or user configuration is accessed.
  const { Host } = await import("./e2e/host.mjs");
  const dataDir = await mkdtemp(join(tmpdir(), "omp-windows-host-smoke-"));
  const host = new Host(inventory.hostBinary, dataDir);
  try {
    const handshake = await host.start();
    console.log(JSON.stringify({ ...inventory, handshake }, null, 2));
  } finally {
    await host.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}
