#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { printf 'whatsapp-mcp-wrapper: node is required. Install Node.js 22+ first.\n' >&2; exit 127; }
exec "$NODE_BIN" "$SCRIPT_DIR/bin/whatseal-mcp.mjs" "$@"
