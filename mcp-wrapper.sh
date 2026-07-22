#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    -h|--help)
      printf 'Usage: mcp-wrapper.sh [--verbose|-v]\n'
      exit 0
      ;;
    *) printf 'whatsapp-mcp-wrapper: unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { printf 'whatsapp-mcp-wrapper: node is required\n' >&2; exit 127; }
printf '%s script=whatsapp-mcp-wrapper pid=%s event=start detail=node=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$NODE_BIN" >&2
if [[ "$VERBOSE" -eq 1 ]]; then
  exec "$NODE_BIN" "$SCRIPT_DIR/mcp-server.mjs" --verbose
else
  exec "$NODE_BIN" "$SCRIPT_DIR/mcp-server.mjs"
fi