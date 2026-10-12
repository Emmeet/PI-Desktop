# omp (oh-my-pi) as the agent engine

Status: Accepted (fork `feat/omp-support`)

## Decision

- omp is the only agent engine. Each conversation runs in its own
  `omp --mode rpc` child process (`packages/agent-runtime/src/omp/`). omp's
  JSONL events (`message_*`, `tool_execution_*`, `prompt_result`) are
  translated into the app's `AgentEventEnvelope`s.
- Sessions are omp's own files under `~/.omp/agent/sessions`. They are listed
  and read by the app, and continued with `omp --resume <file>`. New chats
  start `omp --cwd <project>`. The app reuses the existing `pi-native` session
  plumbing (id prefix `native-pi:`), and `nativeHarness: "omp"` tags the
  sessions.
- Models, credentials, tools, and compaction belong to omp. The app never
  reads `models.yml` or omp's auth store.
- Host-core desktop sessions (the embedded pi runtime) are hidden, and new
  sessions are never created there. `PI_DESKTOP_LEGACY_PI_ENGINE=1` restores
  the old path (unsupported).
- A missing binary surfaces as `OMP_NOT_FOUND` with install instructions.

## P2 desktop integration amendment

### Context

OMP's TUI commands and native desktop capabilities have different owners. RPC
session state cannot depend on a mounted Composer, and broad file/clipboard
access cannot be inferred from a renderer message. Multiple chat windows also
cannot inherit plugin-panel or primary-window trust by matching a URL alone.

### Decision

- Keep stateful session actions and finite loop continuation in the OMP sidecar.
  Reuse OMP goal/BTW/handoff/export semantics; no independent model runner or
  renderer-owned agent loop is introduced.
- Journal desktop-only slash output separately, with invocation and branch
  identities and a manifest for command-only drafts. This supplements the visible
  transcript without modifying OMP's JSONL/context ownership. Export adds an
  escaped appendix rather than inventing engine entries.
- Register Electron's screenshot/open/clipboard capabilities with OMP host-tool
  and URI protocols. Main validates inputs and requests explicit native consent
  for each operation; cancellation/disposal owns pending requests.
- Trust only host-registered chat windows and their original main frame/URL.
  Native window controls route to the invoking window. Broadcast runtime/config
  updates, but deliver navigation to the focused chat. Plugin capabilities keep
  their stricter primary-window ownership.
- Scope exported-file open/reveal grants to verified native save-dialog outputs,
  not an expanded workspace root or arbitrary renderer path.
- OMP configuration remains authoritative for engine preferences. Desktop theme
  accent synchronization is optional and preserves/restores app theme tokens.

### Consequences

Independent renderer windows share engine/session/config authority while owning
their UI selection. Renderer reload does not duplicate loops, but sidecar shutdown
stops them instead of unexpectedly restarting paid work. Native permissions still
depend on platform screenshot/global-key policy. Sharing remains an explicit local
HTML operation; it does not publish a session. Voice integration is outside P2.
