# whatseal-mcp

**Sealed WhatsApp MCP** — every message is sealed until you approve it with
Touch ID or your macOS login password.

This is an isolated, background-only WhatsApp Web linked device exposed to AI
agents via the Model Context Protocol (MCP). Reading chats is free; every
externally visible action (send, reaction, mark-read) requires a physical
biometric approval.

## Security and support boundary

- This integration uses `whatsapp-web.js`, an unofficial WhatsApp Web client.
  WhatsApp can change its web application or policies at any time, which may
  break the integration or restrict the account.
- It is not the official WhatsApp Business Platform. The official platform does
  not expose the historical inbox of a personal WhatsApp account.
- The browser runs headlessly with a dedicated `LocalAuth` directory. It never
  reuses the personal Chrome profile or the shared Playwright browser profile.
- **Bag-safe by default:** when the screen is locked or the laptop lid is closed,
  the daemon pauses the Chrome/WhatsApp hot path (`paused_by_lock=true`), stops
  health polling and call automation, and stays nearly idle. It resumes only
  after unlock + lid open. Disable only if needed with `LOCK_POWER_GUARD=0`.
  No caffeinate / prevent-sleep keep-alives are used.
- **Low-memory browser policy (default `idle`):** the Node control socket stays up,
  but Chrome is closed after `IDLE_CHROME_MS` without WhatsApp RPC (default 15
  minutes; `0` disables idle-close). The next WA method cold-starts via `ensureBrowser`/`ensureReady`.
  Use `BROWSER_POLICY=always` only when you need zero wake latency; `on_demand` keeps
  Chrome closed until the first WA RPC even after unlock. Soft cap docs: `MAX_HOT_BROWSERS=1`.
  Status contract (shared with instaseal): `chromeAlive`, `browserPolicy`, `idleChromeMs`,
  `idleForMs`, `lastRpcAt`; cold phase `idle_cold`. `paused_by_lock` always wins over idle.
- The control interface is a Unix-domain socket with mode `0600`. There is no
  TCP listener by default. The general Web API is explicit opt-in with
  `WHATSEAL_WEB_API=1`; Web sends still use the immutable native Touch ID/password
  approval flow. Compressed call-bot audio can separately enable only a random-token,
  active-call-bound loopback route; the default decoded WAV path needs no TCP.
- A sensitive, persistent WhatsApp browser profile lives under
  `~/.local/share/whatsapp-agent/auth` with mode `0700`. It contains linked
  device credentials plus browser-side WhatsApp caches. It must never be
  committed, synchronized, or copied to chat.
- Pairing QR files live under `~/.local/state/whatsapp-agent`, mode `0600`, and
  are removed immediately after authentication.
- Message bodies, contact names, phone numbers, and QR contents are not written
  to service logs. The backend never calls WhatsApp's media-download API, though
  WhatsApp Web itself may cache thumbnails or other web assets in its profile.
- Chat names, IDs, and message text returned by an MCP read tool enter the active
  agent/model context and may be retained in the IDE transcript or processed by
  the configured model provider. Use a suitable local model when content must
  not leave the Mac.
- Externally visible actions are two-phase. A prepare operation creates a
  ten-minute, single-use approval. The second operation displays the immutable
  target, action type, and exact preview in a native macOS dialog and requires
  Touch ID or the macOS login password before sending, reacting, or marking read.
  An agent cannot derive an approval secret from the first tool result.
- Processes running as the same macOS account can read this account's browser
  profile. Strong isolation from other same-account agents requires a separate
  macOS user; file permissions protect against other OS accounts, not arbitrary
  code already running as the owner.

## Components

| File | Purpose |
| --- | --- |
| `daemon.mjs` | Headless Chrome + WhatsApp client + private Unix socket |
| `lib/lock-power-guard.mjs` | Built-in lock/clamshell power policy (bag-safe default) |
| `lib/browser-lifecycle.mjs` | Idle / on-demand browser policy helpers |
| `lib/http-policy.mjs` | Default-off local HTTP policy + approval-safe Web send adapter |
| `mcp-server.mjs` | Agent tools over MCP stdio |
| `cli.mjs` | Local diagnostic and emergency command-line interface; `install-skill` copies the agent skill |
| `skills/whatseal/` | Bundled `SKILL.md` + references; `install-skill` copies this to agent skill dirs |
| `install-launchagent.sh` | Idempotent macOS LaunchAgent lifecycle (also installs the agent skill) |
| `native-approval.swift` | Immutable native preview + macOS user authentication |
| `native-lock-state.swift` | Lightweight CGSession screen-lock probe |
| `tests/` | Non-networked safety and serialization tests |

See [`RISK-CONTROLS.md`](./RISK-CONTROLS.md) for the threat model, compatibility
gate, update procedure, account-restriction controls, and residual risks. Tested
runtime tuples are recorded in [`KNOWN-GOOD.md`](./KNOWN-GOOD.md).

## Pairing

1. Install and start the background service:

   `./install-launchagent.sh install --account alpha`

2. Wait until `./install-launchagent.sh status --account alpha` reports
   `qrAvailable=true`.
3. Obtain the private QR path with `node cli.mjs qr --account alpha` and open that PNG locally.
4. On the phone, open **WhatsApp → Settings → Linked Devices → Link a Device**
   and scan the QR.
5. Verify `node cli.mjs status --account alpha` reports `ready: true`.

No visible Chrome window is needed. The QR is generated from the headless
linked-device session and the same isolated profile continues running after the
pairing completes.

## Accounts

Copy [`accounts.example.json`](./accounts.example.json) to `accounts.json` and
set the local account ids and aliases. `accounts.json` is gitignored and must
not be committed.

## MCP setup (VS Code / Copilot / Claude Desktop / Hermes)

1. Keep the backend LaunchAgent installed for each account you use.
2. Point the IDE MCP config at `mcp-wrapper.sh` (absolute path):

```json
{
  "servers": {
    "whatseal": {
      "type": "stdio",
      "command": "/ABSOLUTE/PATH/TO/whatseal-mcp/mcp-wrapper.sh"
    }
  }
}
```

Claude Desktop equivalent (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whatseal": {
      "command": "/ABSOLUTE/PATH/TO/whatseal-mcp/mcp-wrapper.sh"
    }
  }
}
```

`mcp-wrapper.sh` (and `./install-launchagent.sh install`) also copies
`skills/whatseal/` to the user-global agent skill dirs — the same Graphify
pattern (`~/.copilot/skills/whatseal/`, `~/.claude/skills/whatseal/`,
`~/.codex/skills/whatseal/`, `~/.agents/skills/whatseal/`,
`~/.hermes/skills/whatseal/`). Manual:

```bash
node cli.mjs install-skill
node cli.mjs install-skill --platform all
node cli.mjs install-skill --platform hermes
node cli.mjs install-skill --platform copilot --project
```

Hermes Agent is a default skill target. After `install-skill`, attach the
stdio server once (then restart Hermes):

```bash
printf 'Y\n' | hermes mcp add whatseal --command /ABSOLUTE/PATH/TO/whatseal-mcp/mcp-wrapper.sh
hermes mcp list
hermes config get mcp_servers
```

Equivalent `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  whatseal:
    command: /ABSOLUTE/PATH/TO/whatseal-mcp/mcp-wrapper.sh
```

Hermes registers those tools as `mcp_whatseal_whatsapp_*`. The bundled
`/whatseal` skill still uses the unprefixed MCP names; map them.

The MCP process only speaks stdio tools. It does **not** auto-start Chrome.
If the backend is stopped or unpaired, tools return structured guidance
(`code`, `userMessage`, `agentNextSteps`, exact shell commands) so other chat
sessions can tell the user to start/pair instead of failing opaquely.
`idle_cold` is not stopped: the control socket is up and the next WhatsApp read
wakes Chrome (up to ~3 minutes). Use `whatsapp_wait_ready` (`timeoutSec=180`)
or `node cli.mjs wait-ready` instead of starting another account.

### Agent workflow expected by server instructions

1. First call: `whatsapp_doctor` or `whatsapp_list_accounts`
2. If `code=IDLE_COLD`: `whatsapp_wait_ready` (`timeoutSec=180`) then retry the read
3. If stopped/unpaired: follow returned `userMessage` / start or pair steps
4. If pairing: `whatsapp_qr` → user scans Linked Devices → `whatsapp_wait_ready`
5. Reads: free (`whatsapp_unread_digest`, `whatsapp_list_chats`, `whatsapp_read_messages`, …)
6. Sends/replies: `prepare_*` → show exact preview → user OK in chat → `whatsapp_request_local_approval`
7. Approval timeout: `whatsapp_send_outcome` (never blind re-prepare)

## Agent tools

### Onboarding / readiness
- `whatsapp_doctor`
- `whatsapp_list_accounts`
- `whatsapp_status`
- `whatsapp_qr`
- `whatsapp_wait_ready`

### Diagnostics
- `whatsapp_compatibility`
- `whatsapp_compatibility_self_test`
- `whatsapp_security_audit`

### Read
- `whatsapp_unread_digest`
- `whatsapp_list_chats`
- `whatsapp_read_messages`
- `whatsapp_search_messages`
- `whatsapp_message_status`

### Write (two-phase + Touch ID)
- `whatsapp_prepare_send`
- `whatsapp_prepare_reply`
- `whatsapp_prepare_rich_test`
- `whatsapp_prepare_mark_read`
- `whatsapp_prepare_reaction`
- `whatsapp_request_local_approval`
- `whatsapp_send_outcome`

Every tool accepts optional `account` (id or alias from `accounts.json`).

`whatsapp_unread_digest` is the inbox watch: unread chats, optional last-message
previews, and a `nextSince` cursor. It never marks chats as seen. Chat listing
still omits last-message previews by default. `whatsapp_read_messages` now
includes quoted-message id/body when present. Quote-replies use
`whatsapp_prepare_reply` with that exact message ID, then the same Touch ID
path. Sending passes `sendSeen: false`, reconciles missing library return
objects against the recent outbound cache, and returns presence to unavailable.
Rich E2E tests generate deterministic assets in memory and do not read arbitrary
user files or address-book contacts. Mark-read and reactions require the same
immutable native authorization. WhatsApp Web is an unofficial and evolving
surface, so verify this behavior after dependency or WhatsApp updates.

## Security Model

- Touch ID (or macOS login password) is required for every externally visible action:
  send, quote-reply, reaction, and mark-read.
- Rate limiting: 20 messages/hour, 100 messages/day, 3-second cooldown.
- No chat history stored locally.
- No TCP listener by default; Unix socket with mode 0600.
- Reading chats never requires approval.

```bash
./install-launchagent.sh install --account myphone
```

## Operations

Every script supports `--verbose` / `-v`.

- Status: `./install-launchagent.sh status`
- Live status (includes `paused_by_lock` / `lockPower` / `chromeAlive` / `idleChromeMs`): `node cli.mjs status --account alpha`
- Wake Chrome after `idle_cold` (up to ~3 minutes): `node cli.mjs wait-ready --account alpha`
- Version report: `node cli.mjs compatibility`
- Content-free upgrade test: `node cli.mjs compatibility-self-test`
- Approve a reviewed machine-local tuple: `node approve-baseline.mjs --approve-current`
- Restart: `./install-launchagent.sh restart`
- Stop: `./install-launchagent.sh stop`
- Remove autostart: `./install-launchagent.sh remove`
- Test: `npm run check`
- Real-process lifecycle E2E: `npm run test:e2e`

### Optional Web UI

The Web UI and gateway are not part of the default daemon attack surface. The
`web/` SPA is adapted from [Karen Okonkwo's WhatsApp Web clone](https://github.com/KarenOk/whatsapp-web-clone)
and is not an official WhatsApp client. Enable the per-account API explicitly
while installing each account, then run the gateway:

`WHATSEAL_WEB_API=1 ./install-launchagent.sh install --account alpha`

`npm run web`

The gateway uses one user-facing loopback port (`127.0.0.1:3000`) and proxies to
the selected account. Posting `/api/send` prepares an immutable draft and opens
the same native Touch ID/password approval used by MCP; there is no direct-send
RPC or HTTP bypass.

### Lock / clamshell power policy (default ON)

Anyone who installs this tool gets bag-safe behavior automatically:

| State | Behavior |
| --- | --- |
| Screen locked **or** lid closed | Destroy Chrome session, stop health/call hot work, set `paused_by_lock=true`, keep control socket for status |
| Unlocked **and** lid open | Resume only if this guard paused the backend (clean LaunchAgent restart) |
| `LOCK_POWER_GUARD=0` | Disable the policy (not recommended for laptops) |

Manual smoke test without locking the Mac (re-render LaunchAgent env):

```bash
# force pause (simulate lock)
LOCK_POWER_GUARD_FORCE=locked ./install-launchagent.sh install --account alpha
node cli.mjs status --account alpha   # expect phase=paused_by_lock, paused_by_lock=true

# clear force / normal bag-safe mode (auto-detect lock & lid)
unset LOCK_POWER_GUARD_FORCE
./install-launchagent.sh install --account alpha
node cli.mjs status --account alpha   # expect reconnect/ready when unlocked
```

Real-world check: lock the screen or close the lid, wait ~5–10s, confirm no
WhatsApp Chrome processes and `paused_by_lock=true`; unlock/open lid and confirm
resume without manual stop/start.

### Browser memory policy (default idle)

| Policy | Behavior |
| --- | --- |
| `idle` (default) | Warm-start Chrome after unlock; close it after `IDLE_CHROME_MS` with no WA RPC; next WA RPC / `wait-ready` wakes (up to ~3 minutes) |
| `always` | Keep Chrome hot while unlocked (highest memory) |
| `on_demand` | Do not open Chrome on boot/unlock; open only on first WA RPC |

```bash
# default install is already idle + 15 minutes
./install-launchagent.sh install --account alpha

# shorter idle for smoke tests
IDLE_CHROME_MS=60000 ./install-launchagent.sh install --account alpha
node cli.mjs status --account alpha   # chromeAlive / idleForMs / phase=idle_cold

# cold until first use
BROWSER_POLICY=on_demand ./install-launchagent.sh install --account alpha

# stop unused accounts instead of leaving warm Chrome forever
./install-launchagent.sh stop --account alpha
```

Status fields (instaseal-compatible): `chromeAlive`, `browserPolicy`, `idleChromeMs`,
`idleForMs`, `lastRpcAt`, cold phase `idle_cold`. Call automation only works while
Chrome is open; with `idle`/`on_demand`, missed ringing during cold periods is
expected. Auto-accept / call-bot stay OFF by default. Prefer stopping unused accounts
rather than multi-profile / always-hot Chromes.

All dependency installs use `npm ci --ignore-scripts` against the committed
lockfile. There is no automatic dependency update. Runtime or lockfile drift
blocks chat content and sends until the local tuple is explicitly re-approved.

Removing the LaunchAgent intentionally preserves linked-device credentials. To
fully revoke access, remove the linked device from the phone first, stop the
service, and then move `~/.local/share/whatsapp-agent` to Trash.
