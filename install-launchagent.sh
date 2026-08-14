#!/bin/bash
# Install and manage the isolated local WhatsApp Web backend LaunchAgent.

set -euo pipefail

LABEL="${WHATSAPP_LAUNCHAGENT_LABEL:-com.local.whatseal-mcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_STATE_DIR="${WHATSAPP_AGENT_STATE:-${HOME}/.local/state/whatsapp-agent}"
BASE_ROOT_DIR="${WHATSAPP_AGENT_ROOT:-${HOME}/.local/share/whatsapp-agent}"
STATE_DIR="$BASE_STATE_DIR"
ROOT_DIR="$BASE_ROOT_DIR"
CHROME_PATH="${WHATSAPP_CHROME_PATH:-}"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
MARKER="${STATE_DIR}/launchagent-owned"
LOG_DIR="${STATE_DIR}/logs"
APPROVAL_HELPER="${STATE_DIR}/native-approval"
BASELINE_APPROVAL_HELPER="${STATE_DIR}/native-baseline-approval"
LOCK_STATE_HELPER="${STATE_DIR}/native-lock-state"
VERBOSE=0
ACTION="install"
ACCOUNT_ID=""
VOICE_DEBUG="${WHATSAPP_DEBUG:-0}"
VOICE_AUTO_ACCEPT="${WHATSAPP_AUTO_ACCEPT_CALLS:-0}"
VOICE_AUTO_ACCEPT_CALLERS="${WHATSAPP_AUTO_ACCEPT_CALLERS:-}"
VOICE_BOT_AUDIO="${WHATSAPP_BOT_AUDIO:-}"
VOICE_BOT_AUDIO_INJECT="${WHATSAPP_BOT_AUDIO_INJECT:-1}"
VOICE_BOT_HANGUP_AFTER_AUDIO="${WHATSAPP_BOT_HANGUP_AFTER_AUDIO:-1}"
VOICE_BOT_HANGUP_PADDING_MS="${WHATSAPP_BOT_HANGUP_PADDING_MS:-1500}"
# Bag-safe by default: pause Chrome/hot work when screen is locked or lid is closed.
# Set LOCK_POWER_GUARD=0 only if you intentionally want the daemon hot while locked.
LOCK_POWER_GUARD="${LOCK_POWER_GUARD:-1}"
LOCK_POWER_GUARD_INTERVAL_MS="${LOCK_POWER_GUARD_INTERVAL_MS:-5000}"
# Optional smoke-test override: locked|unlocked. Leave empty in production installs.
LOCK_POWER_GUARD_FORCE="${LOCK_POWER_GUARD_FORCE:-}"
# Browser memory policy (default idle) — same contract as instaseal:
# always = Chrome always hot; idle = warm start then idle-close; on_demand = cold until first WA RPC.
# IDLE_CHROME_MS default 15m; 0 disables idle-close. Legacy BROWSER_IDLE_MS still accepted.
BROWSER_POLICY="${BROWSER_POLICY:-idle}"
if [[ -n "${IDLE_CHROME_MS:-}" ]]; then
  :
elif [[ -n "${BROWSER_IDLE_MS:-}" ]]; then
  IDLE_CHROME_MS="$BROWSER_IDLE_MS"
else
  IDLE_CHROME_MS="900000"
fi
MAX_HOT_BROWSERS="${MAX_HOT_BROWSERS:-1}"
# Local TCP surfaces are opt-in. The Unix control socket remains always-on.
# WHATSEAL_WEB_API=1 enables the general Web UI API; sends still require native approval.
# WHATSAPP_CALL_AUDIO_HTTP=1 enables only the tokenized call-audio route.
WHATSEAL_WEB_API="${WHATSEAL_WEB_API:-0}"
WHATSAPP_CALL_AUDIO_HTTP="${WHATSAPP_CALL_AUDIO_HTTP:-0}"

log() { printf '%s script=whatsapp-launchagent pid=%s event=%s detail=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$1" "${2:-}"; }
vlog() { [[ "$VERBOSE" -eq 1 ]] && log "debug" "$*" || true; }
fail() { log "error" "$*" >&2; exit 1; }
xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}
validate_boolean() {
  [[ "$2" == "0" || "$2" == "1" ]] || fail "$1 must be 0 or 1"
}
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

Memory defaults: BROWSER_POLICY=idle, IDLE_CHROME_MS=900000 (15m). Use always|idle|on_demand.
TCP defaults: WHATSEAL_WEB_API=0, WHATSAPP_CALL_AUDIO_HTTP=0 (no listener for default WAV audio).
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

[[ -z "$ACCOUNT_ID" || "$ACCOUNT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "account ID may contain only letters, digits, dot, underscore, and hyphen"

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
  LOCK_STATE_HELPER="${STATE_DIR}/native-lock-state"
fi
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || fail "LaunchAgent label may contain only letters, digits, dot, underscore, and hyphen"

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
[[ "$HTTP_PORT" =~ ^[0-9]+$ ]] || fail "WHATSAPP_HTTP_PORT must be an integer"
(( HTTP_PORT >= 1 && HTTP_PORT <= 65535 )) || fail "WHATSAPP_HTTP_PORT must be between 1 and 65535"

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
  if [[ -f "$STATE_DIR/status.json" ]]; then run "$NODE_BIN" -e 'const fs=require("fs"); const p=process.argv[1]; const s=JSON.parse(fs.readFileSync(p)); console.log(`phase=${s.phase||"unknown"}`); console.log(`ready=${Boolean(s.ready)}`); console.log(`qrAvailable=${Boolean(s.qrAvailable)}`); console.log(`paused_by_lock=${Boolean(s.paused_by_lock||s.pausedByLock)}`); console.log(`chromeAlive=${Boolean(s.chromeAlive??s.chrome_alive??s.browserOpen)}`); console.log(`browserPolicy=${s.browserPolicy||s.browserLifecycle?.policy||s.process?.policy||"unknown"}`); console.log(`idleChromeMs=${s.idleChromeMs??s.browserLifecycle?.idleChromeMs??""}`); console.log(`canWake=${Boolean(s.canWake||s.process?.canWake||s.browserLifecycle?.canWake)}`); if(s.lockPower){console.log(`lock_power_enabled=${Boolean(s.lockPower.enabled)}`); if(s.lockPower.reason) console.log(`lock_power_reason=${s.lockPower.reason}`);} if(s.qrPath) console.log(`qrPath=${s.qrPath}`)' "$STATE_DIR/status.json"; else printf 'phase=unknown\n'; fi
  log "progress" "[3/3] 100% — status complete"
}

render_plist() {
  mkdir -p "$PLIST_DIR" "$STATE_DIR" "$LOG_DIR"
  chmod 700 "$STATE_DIR" "$LOG_DIR"
  local temporary="${PLIST}.$$.tmp"
  local escaped_label escaped_node escaped_daemon escaped_account account_args
  local escaped_home escaped_base_state escaped_base_root escaped_chrome escaped_approval escaped_lock_helper escaped_http_port
  local escaped_stdout escaped_stderr escaped_callers escaped_audio audio_entry
  escaped_label="$(xml_escape "$LABEL")"
  escaped_node="$(xml_escape "$NODE_BIN")"
  escaped_daemon="$(xml_escape "$SCRIPT_DIR/daemon.mjs")"
  escaped_account="$(xml_escape "$ACCOUNT_ID")"
  escaped_home="$(xml_escape "$HOME")"
  escaped_base_state="$(xml_escape "$BASE_STATE_DIR")"
  escaped_base_root="$(xml_escape "$BASE_ROOT_DIR")"
  escaped_chrome="$(xml_escape "$CHROME_PATH")"
  escaped_approval="$(xml_escape "$APPROVAL_HELPER")"
  escaped_lock_helper="$(xml_escape "$LOCK_STATE_HELPER")"
  escaped_http_port="$(xml_escape "$HTTP_PORT")"
  escaped_stdout="$(xml_escape "$LOG_DIR/stdout.log")"
  escaped_stderr="$(xml_escape "$LOG_DIR/stderr.log")"
  escaped_callers="$(xml_escape "$VOICE_AUTO_ACCEPT_CALLERS")"
  escaped_audio="$(xml_escape "$VOICE_BOT_AUDIO")"
  account_args=""
  if [[ -n "$ACCOUNT_ID" ]]; then
    account_args="    <string>--account</string>
    <string>${escaped_account}</string>"
  fi
  audio_entry=""
  if [[ -n "$VOICE_BOT_AUDIO" ]]; then
    audio_entry="    <key>WHATSAPP_BOT_AUDIO</key><string>${escaped_audio}</string>"
  fi
  force_entry=""
  if [[ -n "$LOCK_POWER_GUARD_FORCE" ]]; then
    force_entry="    <key>LOCK_POWER_GUARD_FORCE</key><string>$(xml_escape "$LOCK_POWER_GUARD_FORCE")</string>"
  fi
  ( umask 077; cat >"$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escaped_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escaped_node}</string>
    <string>${escaped_daemon}</string>
${account_args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${escaped_home}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>WHATSAPP_AGENT_STATE</key><string>${escaped_base_state}</string>
    <key>WHATSAPP_AGENT_ROOT</key><string>${escaped_base_root}</string>
    <key>WHATSAPP_CHROME_PATH</key><string>${escaped_chrome}</string>
    <key>WHATSAPP_APPROVAL_HELPER</key><string>${escaped_approval}</string>
    <key>WHATSAPP_LOCK_STATE_HELPER</key><string>${escaped_lock_helper}</string>
    <key>WHATSAPP_ACCOUNT_ID</key><string>${escaped_account}</string>
    <key>WHATSAPP_HTTP_PORT</key><string>${escaped_http_port}</string>
    <!-- Local TCP surfaces default OFF. Port is inert unless one is explicitly enabled. -->
    <key>WHATSEAL_WEB_API</key><string>${WHATSEAL_WEB_API}</string>
    <key>WHATSAPP_CALL_AUDIO_HTTP</key><string>${WHATSAPP_CALL_AUDIO_HTTP}</string>
    <!-- Voice-bot defaults fail closed. Supply overrides only while rendering this private plist. -->
    <!-- Chrome is ALWAYS headless by default. Set WHATSAPP_DEBUG=1 only for testing/debugging. -->
    <key>WHATSAPP_DEBUG</key><string>${VOICE_DEBUG}</string>
    <key>WHATSAPP_AUTO_ACCEPT_CALLS</key><string>${VOICE_AUTO_ACCEPT}</string>
    <key>WHATSAPP_AUTO_ACCEPT_CALLERS</key><string>${escaped_callers}</string>
  ${audio_entry}
    <key>WHATSAPP_BOT_AUDIO_INJECT</key><string>${VOICE_BOT_AUDIO_INJECT}</string>
    <key>WHATSAPP_BOT_HANGUP_AFTER_AUDIO</key><string>${VOICE_BOT_HANGUP_AFTER_AUDIO}</string>
    <key>WHATSAPP_BOT_HANGUP_PADDING_MS</key><string>${VOICE_BOT_HANGUP_PADDING_MS}</string>
    <!-- Bag-safe power policy (default ON). Set LOCK_POWER_GUARD=0 to disable. -->
    <key>LOCK_POWER_GUARD</key><string>${LOCK_POWER_GUARD}</string>
    <key>LOCK_POWER_GUARD_INTERVAL_MS</key><string>${LOCK_POWER_GUARD_INTERVAL_MS}</string>
  ${force_entry}
    <!-- Browser memory policy (default idle). always|idle|on_demand; IDLE_CHROME_MS default 15m -->
    <key>BROWSER_POLICY</key><string>${BROWSER_POLICY}</string>
    <key>IDLE_CHROME_MS</key><string>${IDLE_CHROME_MS}</string>
    <key>MAX_HOT_BROWSERS</key><string>${MAX_HOT_BROWSERS}</string>
  </dict>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escaped_stdout}</string>
  <key>StandardErrorPath</key><string>${escaped_stderr}</string>
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

resolve_chrome_path() {
  local managed=0
  if [[ -z "$CHROME_PATH" ]]; then
    managed=1
    CHROME_PATH="$("$NODE_BIN" -e '(async()=>{const path=require("node:path"); const {createRequire}=require("node:module"); const fromProject=createRequire(path.join(process.argv[1], "package.json")); process.stdout.write(await fromProject("puppeteer").executablePath())})().catch((error)=>{console.error(error); process.exit(1)})' "$SCRIPT_DIR")"
    if [[ ! -x "$CHROME_PATH" ]] || ! "$CHROME_PATH" --version >/dev/null 2>&1; then
      "$NODE_BIN" -e 'const path=require("node:path"); const {createRequire}=require("node:module"); const fromProject=createRequire(path.join(process.argv[1], "package.json")); const {getInstalledBrowsers,uninstall}=fromProject("@puppeteer/browsers"); const executable=process.argv[2]; (async()=>{for(let current=path.dirname(executable);current!==path.dirname(current);current=path.dirname(current)){const installed=await getInstalledBrowsers({cacheDir:current}); const match=installed.find(browser=>browser.executablePath===executable); if(match){await uninstall({cacheDir:current,browser:match.browser,buildId:match.buildId,platform:match.platform}); return}}})().catch(error=>{console.error(error);process.exit(1)})' "$SCRIPT_DIR" "$CHROME_PATH"
      log "progress" "installing dedicated Chrome for Testing"
      run "$NPM_BIN" exec --prefix "$SCRIPT_DIR" -- puppeteer browsers install chrome
      CHROME_PATH="$("$NODE_BIN" -e '(async()=>{const path=require("node:path"); const {createRequire}=require("node:module"); const fromProject=createRequire(path.join(process.argv[1], "package.json")); process.stdout.write(await fromProject("puppeteer").executablePath())})().catch((error)=>{console.error(error); process.exit(1)})' "$SCRIPT_DIR")"
    fi
  fi
  [[ "$CHROME_PATH" == /* ]] || fail "WHATSAPP_CHROME_PATH must be absolute"
  [[ -x "$CHROME_PATH" ]] && "$CHROME_PATH" --version >/dev/null 2>&1 || fail "$([[ "$managed" -eq 1 ]] && printf 'Chrome for Testing' || printf 'WHATSAPP_CHROME_PATH') is not usable at $CHROME_PATH"
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
    validate_boolean "WHATSAPP_DEBUG" "$VOICE_DEBUG"
    validate_boolean "WHATSAPP_AUTO_ACCEPT_CALLS" "$VOICE_AUTO_ACCEPT"
    validate_boolean "WHATSAPP_BOT_AUDIO_INJECT" "$VOICE_BOT_AUDIO_INJECT"
    validate_boolean "WHATSAPP_BOT_HANGUP_AFTER_AUDIO" "$VOICE_BOT_HANGUP_AFTER_AUDIO"
    validate_boolean "LOCK_POWER_GUARD" "$LOCK_POWER_GUARD"
    validate_boolean "WHATSEAL_WEB_API" "$WHATSEAL_WEB_API"
    validate_boolean "WHATSAPP_CALL_AUDIO_HTTP" "$WHATSAPP_CALL_AUDIO_HTTP"
    [[ "$VOICE_BOT_HANGUP_PADDING_MS" =~ ^[0-9]+$ ]] || fail "WHATSAPP_BOT_HANGUP_PADDING_MS must be a non-negative integer"
    (( VOICE_BOT_HANGUP_PADDING_MS <= 60000 )) || fail "WHATSAPP_BOT_HANGUP_PADDING_MS must not exceed 60000"
    [[ "$LOCK_POWER_GUARD_INTERVAL_MS" =~ ^[0-9]+$ ]] || fail "LOCK_POWER_GUARD_INTERVAL_MS must be a non-negative integer"
    (( LOCK_POWER_GUARD_INTERVAL_MS >= 1000 && LOCK_POWER_GUARD_INTERVAL_MS <= 60000 )) || fail "LOCK_POWER_GUARD_INTERVAL_MS must be between 1000 and 60000"
    if [[ -n "$LOCK_POWER_GUARD_FORCE" ]]; then
      case "$LOCK_POWER_GUARD_FORCE" in
        locked|unlocked|pause|resume|1|0) ;;
        *) fail "LOCK_POWER_GUARD_FORCE must be locked|unlocked (or empty)" ;;
      esac
    fi
    case "$BROWSER_POLICY" in
      always|idle|on_demand|on-demand|hot|cold|ondemand) ;;
      *) fail "BROWSER_POLICY must be always|idle|on_demand" ;;
    esac
    # Normalize hyphenated form for the plist.
    if [[ "$BROWSER_POLICY" == "on-demand" || "$BROWSER_POLICY" == "ondemand" || "$BROWSER_POLICY" == "cold" ]]; then
      BROWSER_POLICY="on_demand"
    elif [[ "$BROWSER_POLICY" == "hot" ]]; then
      BROWSER_POLICY="always"
    fi
    [[ "$IDLE_CHROME_MS" =~ ^[0-9]+$ ]] || fail "IDLE_CHROME_MS must be a non-negative integer"
    (( IDLE_CHROME_MS <= 86400000 )) || fail "IDLE_CHROME_MS must not exceed 86400000 (24h)"
    [[ "$MAX_HOT_BROWSERS" =~ ^[0-9]+$ ]] || fail "MAX_HOT_BROWSERS must be a positive integer"
    (( MAX_HOT_BROWSERS >= 1 && MAX_HOT_BROWSERS <= 8 )) || fail "MAX_HOT_BROWSERS must be between 1 and 8"
    if [[ -n "$VOICE_BOT_AUDIO" ]]; then
      [[ "$VOICE_BOT_AUDIO" == /* ]] || fail "WHATSAPP_BOT_AUDIO must be an absolute path"
      [[ -f "$VOICE_BOT_AUDIO" && ! -L "$VOICE_BOT_AUDIO" ]] || fail "WHATSAPP_BOT_AUDIO must be a regular non-symlink file"
    fi
    [[ "$STATE_DIR" == /* && "$ROOT_DIR" == /* ]] || fail "runtime override paths must be absolute"
    if is_loaded && { ! is_owned || ! loaded_is_owned; }; then fail "refusing to replace a loaded foreign LaunchAgent label: ${LABEL}"; fi
    if [[ -f "$PLIST" ]] && ! is_owned; then fail "refusing to overwrite foreign LaunchAgent: $PLIST"; fi
    log "progress" "[0/8] 0% — validating the exact dependency lockfile"
    run env PUPPETEER_SKIP_DOWNLOAD=true "$NPM_BIN" ci --prefix "$SCRIPT_DIR" --omit=dev --ignore-scripts --no-audit --no-fund --dry-run
    log "progress" "[1/8] 12% — stopping the previous owned instance"
    stop_agent
    log "progress" "[2/8] 25% — installing the exact dependency lockfile"
    install_dependencies_transactional || fail "exact dependency installation failed and previous dependencies were restored"
    resolve_chrome_path
    log "progress" "[3/8] 38% — compiling message Touch ID approval helper"
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    run xcrun swiftc "$SCRIPT_DIR/native-approval.swift" -framework AppKit -framework LocalAuthentication -o "${APPROVAL_HELPER}.tmp"
    run chmod 500 "${APPROVAL_HELPER}.tmp"
    run /bin/mv -f "${APPROVAL_HELPER}.tmp" "$APPROVAL_HELPER"
    log "progress" "[4/8] 50% — compiling baseline Touch ID approval helper"
    run xcrun swiftc "$SCRIPT_DIR/native-baseline-approval.swift" -framework AppKit -framework LocalAuthentication -o "${BASELINE_APPROVAL_HELPER}.tmp"
    run chmod 500 "${BASELINE_APPROVAL_HELPER}.tmp"
    run /bin/mv -f "${BASELINE_APPROVAL_HELPER}.tmp" "$BASELINE_APPROVAL_HELPER"
    log "progress" "[5/8] 62% — compiling lock/clamshell state helper"
    run xcrun swiftc "$SCRIPT_DIR/native-lock-state.swift" -framework CoreGraphics -o "${LOCK_STATE_HELPER}.tmp"
    run chmod 500 "${LOCK_STATE_HELPER}.tmp"
    run /bin/mv -f "${LOCK_STATE_HELPER}.tmp" "$LOCK_STATE_HELPER"
    log "progress" "[6/8] 75% — rendering private LaunchAgent"
    render_plist
    log "progress" "[7/8] 88% — starting bag-safe headless backend"
    start_agent
    log "progress" "[8/8] 100% — install complete"
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