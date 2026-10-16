import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEVELOPMENT_DATA_DIR_NAME, INSTALLATION_DATA_DIR_NAME } from "../data-paths";
import { contains, migrateFiles } from "./files";
import { readStoragePreferences, STORAGE_PREFERENCE_FILE, writeStoragePreferences, type StoragePreferences } from "./preferences";

const IMPORT_JOURNAL = "omp-first-start-import.json";

/** Resolve missing leaf paths without creating anything in either installation. */
function canonicalStoragePath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error("Storage root is unavailable.");
  return join(canonicalStoragePath(parent), basename(path));
}

function assertPrivateRoots(owned: string[], upstream: string[]): void {
  for (const path of owned) {
    const canonical = canonicalStoragePath(resolve(path));
    for (const source of upstream) {
      const original = canonicalStoragePath(resolve(source));
      if (contains(canonical, original) || contains(original, canonical)) {
        throw new Error("OMP storage overlaps the PI-Desktop installation. Choose separate private storage before starting.");
      }
    }
  }
}

/** Never activate upstream roots: publish only a complete verified private copy. */
export async function importLegacyProfile(input: {
  defaultData: string;
  anchor: string;
  appData: string;
  relocate: (source: string, destination: string) => Promise<void>;
}): Promise<void> {
  const { defaultData, anchor, appData, relocate } = input;
  const development = basename(defaultData) === DEVELOPMENT_DATA_DIR_NAME;
  if (!development && basename(defaultData) !== INSTALLATION_DATA_DIR_NAME) return;
  const legacyData = join(dirname(defaultData), development ? ".pi-desktop-dev" : ".pi-desktop");
  const legacyBrowser = join(appData, development ? "PI-Desktop Dev" : "PI-Desktop");
  const legacyPreference = join(legacyBrowser, STORAGE_PREFERENCE_FILE);
  const preferenceFile = join(anchor, STORAGE_PREFERENCE_FILE);
  const journalFile = join(anchor, IMPORT_JOURNAL);
  const established = existsSync(preferenceFile) || (!existsSync(journalFile)
    && lstatSync(defaultData, { throwIfNoEntry: false })?.isDirectory()
    && readdirSync(defaultData).length > 0);
  let legacy: StoragePreferences;
  if (established && existsSync(journalFile)) {
    // A completed import owns its source record. Later upstream configuration
    // changes must not block OMP or weaken checks against the original roots.
    legacy = readStoragePreferences(journalFile, { data: legacyData, browser: legacyBrowser });
  } else {
    try {
      legacy = readStoragePreferences(legacyPreference, { data: legacyData, browser: legacyBrowser });
    } catch (error) {
      if (!established) throw error;
      // Never include legacy contents or backend error details in diagnostics.
      console.warn("Ignoring unreadable legacy storage preferences for an existing OMP profile.");
      legacy = { version: 1, roots: { data: legacyData, browser: legacyBrowser }, backups: [] };
    }
  }
  const upstream = [legacyData, legacyBrowser, ...[legacy.roots.data, legacy.roots.browser].filter((path) =>
    path !== join(anchor, ".omp-import-empty-data") && path !== join(anchor, ".omp-import-empty-browser"))];
  // Validate before even creating the anchor: a redirected userData must never
  // receive an OMP journal, preference, or empty staging directory.
  if (lstatSync(anchor, { throwIfNoEntry: false })?.isSymbolicLink()
    || canonicalStoragePath(anchor) !== join(canonicalStoragePath(appData), relative(appData, anchor))) {
    throw new Error("OMP installation anchor must be a private directory, not a symbolic link.");
  }
  if (lstatSync(defaultData, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("OMP storage must be a private directory, not a symbolic link.");
  }
  assertPrivateRoots([anchor, defaultData], upstream);
  if (existsSync(preferenceFile)) {
    const existing = readStoragePreferences(preferenceFile, { data: defaultData, browser: anchor });
    assertPrivateRoots([existing.roots.data, existing.roots.browser], upstream);
    return;
  }
  let journal: StoragePreferences;
  if (existsSync(journalFile)) {
    journal = readStoragePreferences(journalFile, { data: defaultData, browser: anchor });
    if (journal.pending?.kind !== "migrate" || journal.pending.target !== defaultData) {
      throw new Error("Invalid OMP first-start import journal. Restore it before starting.");
    }
    const upstreamRoots = [journal.roots.data, journal.roots.browser].filter((path) =>
      path !== join(anchor, ".omp-import-empty-data") && path !== join(anchor, ".omp-import-empty-browser"));
    assertPrivateRoots([anchor, defaultData], upstreamRoots);
  } else {
    // Existing OMP data always wins, including a profile created before import existed.
    if (existsSync(defaultData)) {
      if (readdirSync(defaultData).length) return;
    }
    if (!existsSync(legacyData) && !existsSync(legacyBrowser)) {
      // Record the first-start decision; do not unexpectedly import a later PI install.
      writeStoragePreferences(preferenceFile, { version: 1, roots: { data: defaultData, browser: anchor }, backups: [] });
      return;
    }
    const emptyBrowser = join(anchor, ".omp-import-empty-browser");
    const browser = existsSync(legacyBrowser) ? legacyBrowser : emptyBrowser;
    if (browser === emptyBrowser) mkdirSync(browser, { recursive: true, mode: 0o700 });
    const emptyData = join(anchor, ".omp-import-empty-data");
    const data = existsSync(legacyData) ? legacyData : emptyData;
    if (data === emptyData) mkdirSync(data, { recursive: true, mode: 0o700 });
    const source = readStoragePreferences(legacyPreference, { data, browser });
    if (source.pending) throw new Error("PI-Desktop has pending storage maintenance. Complete it and close PI-Desktop before importing.");
    if (!existsSync(source.roots.data) || !existsSync(source.roots.browser)) {
      throw new Error("The PI-Desktop storage location is unavailable. Reconnect it before importing.");
    }
    journal = { version: 1 as const, roots: source.roots, backups: [],
      pending: { id: randomUUID(), kind: "migrate" as const, target: defaultData, language: "en" } };
    writeStoragePreferences(journalFile, journal);
  }
  const id = journal.pending?.id;
  if (!id) throw new Error("Missing OMP first-start import ownership.");
  if (!existsSync(journal.roots.data) || !existsSync(journal.roots.browser)) {
    throw new Error("The PI-Desktop import source is unavailable. Restore it before retrying.");
  }
  mkdirSync(defaultData, { recursive: true, mode: 0o700 });
  const next = await migrateFiles({ source: journal.roots, target: defaultData, anchor,
    id, progress: () => {}, relocate, verifySource: true });
  // The existing atomic preference publication is the only commit point. In
  // particular, upstream roots are never registered as deletable OMP backups.
  writeStoragePreferences(preferenceFile, { version: 1, roots: next, backups: [] });
}
