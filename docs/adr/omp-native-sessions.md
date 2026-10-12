# omp (oh-my-pi) native sessions

Status: Proposed (fork `feat/omp-support`)

## Context

PI-Desktop embeds the upstream pi SDK (`@earendil-works/pi-coding-agent`)
in-process and can import and continue native pi CLI sessions from
`~/.pi/agent/sessions`. oh-my-pi (`omp`, `@oh-my-pi/pi-coding-agent`) is a
Bun-based pi fork that stores its state under `~/.omp/agent` and has diverged
from pi: different tools, entry types, auth store, and `models.yml`. It cannot
be loaded as a library inside the Electron/Node sidecar.

## Decision

- The native session service is parameterized by a harness (`pi` | `omp`).
  The sidecar runs one service per harness, merges `native.session.list` and
  `native.session.search`, and routes per-session calls to the service that
  discovered the id.
- omp sessions are discovered from `~/.omp/agent/sessions`
  (override: `PI_DESKTOP_OMP_AGENT_DIR`; disable: `PI_DESKTOP_OMP_SESSIONS=0`).
  `PI_CODING_AGENT_DIR` is not used for omp because both CLIs honor it.
- omp sessions are always read-only (`readOnlyReason: "omp-harness"`): list,
  search, and view work; prompt and fork are refused before any file is
  opened for writing. The pi model runtime is never pointed at omp's auth.
- `SessionSummary.nativeHarness` tags each native session; the sidebar shows
  an `OMP` badge instead of `Pi`.
- pi stays the default and its behavior is unchanged.

## Not done

Running omp as a live agent backend (spawning `omp --mode rpc` or `--mode acp`
and mapping its event stream into `AgentEventEnvelope`) is a separate,
larger change.
