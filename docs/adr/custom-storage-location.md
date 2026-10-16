# ADR: Custom storage location with cold migration

- Status: Accepted
- Date: 2026-10-01
- Related: issue #1213, ADR 0011, ADR 0094

## Context

Application data and Chromium's browser/plugin state accumulate on the default
system volume. Changing only the host root strands browser state and absolute
internal attachment/plugin references. Copying a live database/profile also risks
inconsistent snapshots and writes arriving after the location has changed.

## Decision

Use explicit settings confirmation followed by existing ordered shutdown. Journal
pending work in the original Electron userData directory, which remains the stable
installation identity and single-instance lock. Before booting application writers,
a sandboxed nonpersistent Electron window displays cold migration progress.

An empty selected destination owns `data/` and `browser/`. The production Node
filesystem service copies all profile files, preserves links/permissions, verifies
SHA-256 bytes and records ownership for retry. Rust alone rewrites known host-owned
structured paths and the copied SQLite index in an offline CLI mode, without
schema upgrades, startup recovery, or scratch sweeps. The durable pointer is
atomically published after these steps. Normal startup sets Chromium sessionData
before ready and passes the selected data root to all existing services.

Keep source profiles as visible backups, with a separate confirmed cleanup action.
Cache clearing uses an explicit cold filesystem allowlist; it never clears durable
storage or follows redirecting links. Explicit environment-controlled profiles keep
the existing override and opt-out locking semantics, and disable these actions.

The entry module completes synchronous identity/locking, then asynchronously
prepares storage and imports the composition root. It does not top-level-await
app.whenReady: Electron gates readiness on main-module evaluation. Normal startup
uses whenReady promises so importing after readiness still installs services.

## Alternatives

- Live relocation: rejected because SQLite, plugin processes, browser partitions,
  outbox and logs do not share an atomic live-switch boundary.
- Cache-only relocation: does not satisfy the requested complete storage migration.
- Move userData and its lock: changes installation identity and admits competing
  launches while migrating. Keeping the small bootstrap anchor avoids that change.
- Rewrite every matching byte/string: would corrupt credentials, user commands,
  code, prose, Chromium databases and unknown plugin-owned formats.

## Consequences

The default profile and Rust ownership remain compatible. Migration needs room for
one full verified copy plus metadata; originals consume space until the user
checks the migrated installation and separately removes backups. Source data is
untouched on copy/relocation failures. A missing custom volume blocks startup with
a recovery message rather than creating a misleading empty profile.

Unknown plugin-private absolute references and historical narrative paths retain
their bytes; extension authors own their portability. Backup deletion warns users
to check these references. Ordinary external project directories are never moved.
No schema/protocol version bump or plugin SDK change is required; storage IPC is
additive, main-window-only, and preferences stay machine-local.

## OMP Desktop first-start import (2026-10-16)

First-start import is a separate fork cutover, not an in-place upstream relocation.
Before application writers start, an OMP-owned import journal claims the isolated
destination, copies the matching upstream host and Electron profile read-only,
and verifies source inventories and hashes before and after copying. A legacy
custom storage pointer is honored; pending upstream maintenance, unavailable
volumes or concurrent source writes prevent publication. Close PI-Desktop first.

Rust opens and relocates/checkpoints only the copied SQLite database, including
its copied WAL state. The original database and WAL/SHM are never opened for writes
or checkpointed. The atomic OMP pointer activates the verified `data/` and
`browser/` copy; failures retain journal ownership for a same-destination retry
and refuse a partial startup. Existing OMP data/preferences and explicit root or
profile overrides prevent automatic import. Upstream source trees remain manual
recovery copies and are not offered by OMP backup cleanup.

Cross-install import rejects all retained data/browser symlinks (transient Chromium
locks are excluded), rather than inheriting ordinary relocation's external-link
preservation. Canonical OMP anchor/default-root disjointness from upstream
default/custom roots is validated before journal/directory/preference writes;
an existing OMP pointer is never allowed to activate an upstream root.

Rust's first-start-only `--import-data <source> <copy>` reuses relocation, rejects
copied symlinks, and removes only the copied `secret:installation:oauth-device-id`.
The existing identity creator generates a fresh OMP device id on next OAuth use;
machine key, provider credentials and upstream bytes remain unchanged. Ordinary
settings moves keep `--relocate-data` and their existing installation-local
identity and link-preservation policy.

An established private OMP installation must not depend on the continuing validity
of upstream preferences. Completed-import disjointness uses original source roots
recorded in OMP's journal, retaining custom-source alias protection even if upstream
configuration breaks. Existing private profiles without a journal tolerate a legacy
preference-read failure with a generic content-free warning. First-start import
still requires valid upstream preferences, and errors in current OMP preferences
or its ownership journal remain fatal.

