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
