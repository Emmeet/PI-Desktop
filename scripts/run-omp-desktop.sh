#!/usr/bin/env bash
# Launch OMP Desktop from a source checkout (Linux/macOS).
# Builds anything missing, then starts Electron.
#   PI_DESKTOP_OMP_MODEL=provider/model  optional default model for new chats
#   OMP_DESKTOP_NO_SANDBOX=1             source development only (containers / VMs)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
# This opt-out is never consumed by packaged application code.
if [ "${OMP_DESKTOP_NO_SANDBOX:-0}" = "1" ]; then
  if [ "${NODE_ENV:-development}" = "production" ] || ! node -e '
    const p = require(process.argv[1]);
    process.exit(p.piDistribution === "installed" ? 1 : 0);
  ' "$root/apps/desktop/package.json"; then
    echo "OMP_DESKTOP_NO_SANDBOX is restricted to source development." >&2
    exit 1
  fi
fi
if ! command -v omp >/dev/null 2>&1 && [ -z "${PI_DESKTOP_OMP_BIN:-}" ]; then
  echo "warning: 'omp' not found. Install: bun install -g @oh-my-pi/pi-coding-agent" >&2
fi
host="$root/target/debug/pi-desktop-host-core"
[ -x "$host" ] || (cd "$root" && cargo build -p host-core)
[ -f "$root/packages/agent-runtime/dist/sidecar.js" ] || (cd "$root" && pnpm build:js)
[ -f "$root/apps/desktop/out/main/index.js" ] || (cd "$root/apps/desktop" && pnpm build)
export PI_DESKTOP_HOST_BIN="$host"
export ELECTRON_RENDERER_URL=""
args=()
[ "${OMP_DESKTOP_NO_SANDBOX:-0}" = "1" ] && args+=(--no-sandbox)
cd "$root/apps/desktop"
exec "$root/apps/desktop/node_modules/.bin/electron" "${args[@]}" . "$@"
