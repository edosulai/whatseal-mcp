#!/bin/bash
# Install and manage the isolated local WhatsApp Web backend LaunchAgent.

set -euo pipefail

LABEL="${WHATSAPP_LAUNCHAGENT_LABEL:-com.local.whatseal-mcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_STATE_DIR="${WHATSAPP_AGENT_STATE:-${HOME}/.local/state/whatsapp-agent}"
BASE_ROOT_DIR="${WHATSAPP_AGENT_ROOT:-${HOME}/.local/share/whatsapp-agent}"
STATE_DIR="$BASE_STATE_DIR"
ROOT_DIR="$BASE_ROOT_DIR"
CHROME_PATH="${WHATSAPP_CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
MARKER="${STATE_DIR}/launchagent-owned"
LOG_DIR="${STATE_DIR}/logs"
APPROVAL_HELPER="${STATE_DIR}/native-approval"
BASELINE_APPROVAL_HELPER="${STATE_DIR}/native-baseline-approval"
VERBOSE=0
ACTION="install"
ACCOUNT_ID=""

log() { printf '%s script=whatsapp-launchagent pid=%s event=%s detail=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$1" "${2:-}"; }
vlog() { [[ "$VERBOSE" -eq 1 ]] && log "debug" "$*" || true; }
fail() { log "error" "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: install-launchagent.sh [install|status|start|stop|restart|remove] [--account ID] [--verbose|-v]

  install   Install dependencies, render the private LaunchAgent, and start it.
  status    Show launchd, socket, and pairing status without reading messages.
  start     Start an already installed agent.
  stop      Stop an already installed agent.
  restart   Restart an already installed agent.
  remove    Stop and remove only a LaunchAgent owned by this installer.

Options:
  --account ID   Target a specific account (e.g. alpha, beta). Without this,
                 operates on the legacy single-account instance.

Verbose mode prints every external command and decision branch.
EOF
}

for arg in "$@"; do
  case "$arg" in
    install|status|start|stop|restart|remove) ACTION="$arg" ;;
    -v|--verbose) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    --account) ;; # value handled below
    *) if [[ "${prev_arg:-}" == "--account" ]]; then ACCOUNT_ID="$arg"; else fail "unknown argument: $arg"; fi ;;
  esac
  prev_arg="$arg"
done

# Apply account-specific paths
HTTP_PORT="${WHATSAPP_HTTP_PORT:-}"
if [[ -n "$ACCOUNT_ID" ]]; then
  LABEL="${WHATSAPP_LAUNCHAGENT_LABEL:-com.local.whatseal-mcp}.${ACCOUNT_ID}"
  STATE_DIR="${STATE_DIR}/${ACCOUNT_ID}"
  ROOT_DIR="${ROOT_DIR}/${ACCOUNT_ID}"
  LOG_DIR="${STATE_DIR}/logs"
  PLIST="${PLIST_DIR}/${LABEL}.plist"
  MARKER="${STATE_DIR}/launchagent-owned"
  APPROVAL_HELPER="${STATE_DIR}/native-approval"
  BASELINE_APPROVAL_HELPER="${STATE_DIR}/native-baseline-approval"
fi

# Port = 30000 + last 4 digits of account id (uses the last 4 digits of the account id):
#   beta → 30001
#   alpha → 30001
# Explicit WHATSAPP_HTTP_PORT always wins.
if [[ -z "$HTTP_PORT" ]]; then
  id_for_port="${ACCOUNT_ID:-alpha}"
  digits="$(printf '%s' "$id_for_port" | tr -cd '0-9')"
  [[ -n "$digits" ]] || digits="0001"
  # last 4 chars, left-pad with zeros (preserves 0001 → 0001, not 1)
  last4="$(printf '%s' "$digits" | awk '{ s=$0; while (length(s)<4) s="0" s; print substr(s, length(s)-3) }')"
  HTTP_PORT=$((30000 + 10#$last4))
fi

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
DOMAIN="gui/$(id -u)"

run() {
  vlog "+ $*"
  if "$@"; then
    local exit_code=0
    vlog "exit=${exit_code} command=$1"
    return 0
  else
    local exit_code=$?
    log "error" "exit=${exit_code} command=$1"
    return "$exit_code"
  fi
}

is_loaded() { launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; }
loaded_is_owned() {
  is_loaded || return 1
  launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | grep -Fq "$SCRIPT_DIR/daemon.mjs"
}
is_owned() {
  [[ -f "$MARKER" ]] || return 1
  [[ -f "$PLIST" ]] || return 1
  local plist_program marker_owner marker_script
  plist_program="$(plutil -extract ProgramArguments.1 raw -o - "$PLIST" 2>/dev/null || true)"
  marker_owner="$(sed -n 's/^owner=//p' "$MARKER")"
  marker_script="$(sed -n 's/^script=//p' "$MARKER")"
  [[ "$plist_program" == "$SCRIPT_DIR/daemon.mjs" ]] || return 1
  [[ "$marker_owner" == "$LABEL" ]] || return 1
  [[ "$marker_script" == "$SCRIPT_DIR/daemon.mjs" ]]
}

show_status() {
  log "progress" "[0/3] 0% — checking LaunchAgent"
  if is_loaded; then printf 'launchagent=loaded\n'; else printf 'launchagent=not-loaded\n'; fi
  log "progress" "[1/3] 33% — checking private control socket"
  if [[ -S "$STATE_DIR/control.sock" ]]; then printf 'socket=present:%s\n' "$STATE_DIR/control.sock"; else printf 'socket=missing\n'; fi
  log "progress" "[2/3] 66% — checking backend state"
  if [[ -f "$STATE_DIR/status.json" ]]; then run "$NODE_BIN" -e 'const fs=require("fs"); const p=process.argv[1]; const s=JSON.parse(fs.readFileSync(p)); console.log(`phase=${s.phase||"unknown"}`); console.log(`ready=${Boolean(s.ready)}`); console.log(`qrAvailable=${Boolean(s.qrAvailable)}`); if(s.qrPath) console.log(`qrPath=${s.qrPath}`)' "$STATE_DIR/status.json"; else printf 'phase=unknown\n'; fi
  log "progress" "[3/3] 100% — status complete"
}

render_plist() {
  mkdir -p "$PLIST_DIR" "$STATE_DIR" "$LOG_DIR"
  chmod 700 "$STATE_DIR" "$LOG_DIR"
  local temporary="${PLIST}.$$.tmp"
  ( umask 077; cat >"$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SCRIPT_DIR}/daemon.mjs</string>
$(if [[ -n "$ACCOUNT_ID" ]]; then printf '    <string>--account</string>\n    <string>%s</string>\n' "$ACCOUNT_ID"; fi)  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>WHATSAPP_AGENT_STATE</key><string>${BASE_STATE_DIR}</string>
    <key>WHATSAPP_AGENT_ROOT</key><string>${BASE_ROOT_DIR}</string>
    <key>WHATSAPP_CHROME_PATH</key><string>${CHROME_PATH}</string>
    <key>WHATSAPP_APPROVAL_HELPER</key><string>${APPROVAL_HELPER}</string>
    <key>WHATSAPP_ACCOUNT_ID</key><string>${ACCOUNT_ID}</string>
    <key>WHATSAPP_HTTP_PORT</key><string>${HTTP_PORT}</string>
    <!-- Run Chrome invisibly in the LaunchAgent session. -->
    <key>WHATSAPP_HEADLESS</key><string>1</string>
    <!-- Voice-bot toggles (set any to 0 to disable; reinstall/restart after edit). -->
    <key>WHATSAPP_AUTO_ACCEPT_CALLS</key><string>1</string>
    <key>WHATSAPP_BOT_AUDIO_INJECT</key><string>1</string>
    <key>WHATSAPP_BOT_HANGUP_AFTER_AUDIO</key><string>1</string>
  </dict>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>
EOF
  )
  run plutil -lint "$temporary" >/dev/null
  run chmod 600 "$temporary"
  run mv "$temporary" "$PLIST"
  ( umask 077; printf 'owner=%s\nscript=%s\n' "$LABEL" "$SCRIPT_DIR/daemon.mjs" >"${MARKER}.tmp" )
  run mv "${MARKER}.tmp" "$MARKER"
  chmod 600 "$MARKER"
}

install_dependencies_transactional() {
  local live="${SCRIPT_DIR}/node_modules"
  local backup="${SCRIPT_DIR}/.node_modules.previous.$$"
  local partial="${SCRIPT_DIR}/.node_modules.installing.$$"
  run rm -rf "$backup" "$partial"
  if [[ -d "$live" ]]; then
    run mv "$live" "$backup"
  fi

  if run env PUPPETEER_SKIP_DOWNLOAD=true "$NPM_BIN" ci --prefix "$SCRIPT_DIR" --omit=dev --ignore-scripts --no-audit --no-fund; then
    run rm -rf "$backup"
    return 0
  fi

  log "error" "dependency installation failed; restoring previous node_modules"
  if [[ -d "$live" ]]; then run mv "$live" "$partial"; fi
  if [[ -d "$backup" ]]; then run mv "$backup" "$live"; fi
  run rm -rf "$partial"
  return 1
}

stop_agent() {
  if is_loaded; then
    loaded_is_owned || fail "refusing to stop a loaded job whose daemon path does not match this installer"
    run launchctl bootout "${DOMAIN}/${LABEL}" || fail "launchctl refused to stop ${LABEL}"
    local i total=40
    for i in $(seq 1 "$total"); do
      local pct=$(( i * 100 / total ))
      log "progress" "[$i/$total] ${pct}% — waiting for backend shutdown"
      is_loaded || break
      sleep 0.25
    done
    is_loaded && fail "LaunchAgent remained loaded after bootout"
    for i in $(seq 1 "$total"); do
      local pct=$(( i * 100 / total ))
      log "progress" "[$i/$total] ${pct}% — waiting for control socket removal"
      [[ ! -S "$STATE_DIR/control.sock" ]] && break
      sleep 0.25
    done
    [[ ! -S "$STATE_DIR/control.sock" ]] || fail "control socket remained after backend stop"
  else
    vlog "skip stop: label is not loaded"
  fi
}

start_agent() {
  [[ -f "$PLIST" ]] || fail "LaunchAgent is not installed: $PLIST"
  is_owned || fail "refusing to start an unowned or mismatched LaunchAgent"
  if is_loaded; then
    loaded_is_owned || fail "label is loaded by a foreign or mismatched job"
    vlog "skip start: label is already loaded"
    return 0
  fi
  run launchctl bootstrap "$DOMAIN" "$PLIST"
}

show_observability() {
  local pid
  pid="$(launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | awk '/^[[:space:]]*pid = / { print $3; exit }')"
  printf 'pid=%s\n' "${pid:-unknown}"
  printf 'stdout_log=%s\n' "$LOG_DIR/stdout.log"
  printf 'stderr_log=%s\n' "$LOG_DIR/stderr.log"
  printf 'tail_command=tail -f %q %q\n' "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"
  printf 'stop_command=%q stop\n' "$0"
}

case "$ACTION" in
  install)
    log "start" "installing isolated WhatsApp backend"
    [[ -n "$NODE_BIN" ]] || fail "node is required"
    [[ -n "$NPM_BIN" ]] || fail "npm is required"
    command -v swiftc >/dev/null 2>&1 || fail "swiftc is required for Touch ID approval"
    [[ "$STATE_DIR" == /* && "$ROOT_DIR" == /* && "$CHROME_PATH" == /* ]] || fail "runtime override paths must be absolute"
    [[ -x "$CHROME_PATH" ]] || fail "Google Chrome is required at $CHROME_PATH"
    if is_loaded && { ! is_owned || ! loaded_is_owned; }; then fail "refusing to replace a loaded foreign LaunchAgent label: ${LABEL}"; fi
    if [[ -f "$PLIST" ]] && ! is_owned; then fail "refusing to overwrite foreign LaunchAgent: $PLIST"; fi
    log "progress" "[0/7] 0% — validating the exact dependency lockfile"
    run env PUPPETEER_SKIP_DOWNLOAD=true "$NPM_BIN" ci --prefix "$SCRIPT_DIR" --omit=dev --ignore-scripts --no-audit --no-fund --dry-run
    log "progress" "[1/7] 14% — stopping the previous owned instance"
    stop_agent
    log "progress" "[2/7] 28% — installing the exact dependency lockfile"
    install_dependencies_transactional || fail "exact dependency installation failed and previous dependencies were restored"
    log "progress" "[3/7] 42% — compiling message Touch ID approval helper"
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    run xcrun swiftc "$SCRIPT_DIR/native-approval.swift" -framework AppKit -framework LocalAuthentication -o "${APPROVAL_HELPER}.tmp"
    run chmod 500 "${APPROVAL_HELPER}.tmp"
    run /bin/mv -f "${APPROVAL_HELPER}.tmp" "$APPROVAL_HELPER"
    log "progress" "[4/7] 57% — compiling baseline Touch ID approval helper"
    run xcrun swiftc "$SCRIPT_DIR/native-baseline-approval.swift" -framework AppKit -framework LocalAuthentication -o "${BASELINE_APPROVAL_HELPER}.tmp"
    run chmod 500 "${BASELINE_APPROVAL_HELPER}.tmp"
    run /bin/mv -f "${BASELINE_APPROVAL_HELPER}.tmp" "$BASELINE_APPROVAL_HELPER"
    log "progress" "[5/7] 71% — rendering private LaunchAgent"
    render_plist
    log "progress" "[6/7] 85% — starting headless backend"
    start_agent
    log "progress" "[7/7] 100% — install complete"
    show_observability
    show_status
    ;;
  status) show_status ;;
  start) start_agent; show_observability; show_status ;;
  stop) is_owned || fail "refusing to stop an unowned or mismatched LaunchAgent"; stop_agent; show_status ;;
  restart) is_owned || fail "refusing to restart an unowned or mismatched LaunchAgent"; stop_agent; start_agent; show_observability; show_status ;;
  remove)
    log "start" "removing owned WhatsApp LaunchAgent"
    is_owned || fail "refusing to remove an unowned or mismatched LaunchAgent"
    stop_agent
    run rm -f "$PLIST" "$MARKER"
    log "complete" "LaunchAgent removed; linked-device credentials remain in $HOME/.local/share/whatsapp-agent/auth"
    ;;
esac