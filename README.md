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
- The control interface is a Unix-domain socket with mode `0600`; there is no
  TCP listener.
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
| `mcp-server.mjs` | Agent tools over MCP stdio |
| `cli.mjs` | Local diagnostic and emergency command-line interface |
| `install-launchagent.sh` | Idempotent macOS LaunchAgent lifecycle |
| `native-approval.swift` | Immutable native preview + macOS user authentication |
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

## MCP setup (VS Code / Copilot / Claude Desktop)

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

The MCP process only speaks stdio tools. It does **not** auto-start Chrome.
If the backend is stopped or unpaired, tools return structured guidance
(`code`, `userMessage`, `agentNextSteps`, exact shell commands) so other chat
sessions can tell the user to start/pair instead of failing opaquely.

### Agent workflow expected by server instructions

1. First call: `whatsapp_doctor` or `whatsapp_list_accounts`
2. If not ready: follow returned `userMessage` / start or pair steps
3. If pairing: `whatsapp_qr` → user scans Linked Devices → `whatsapp_wait_ready`
4. Reads: free (`whatsapp_list_chats`, `whatsapp_read_messages`, …)
5. Sends: `prepare_*` → show exact preview → user OK in chat → `whatsapp_request_local_approval`
6. Approval timeout: `whatsapp_send_outcome` (never blind re-prepare)

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
- `whatsapp_list_chats`
- `whatsapp_read_messages`
- `whatsapp_search_messages`
- `whatsapp_message_status`

### Write (two-phase + Touch ID)
- `whatsapp_prepare_send`
- `whatsapp_prepare_rich_test`
- `whatsapp_prepare_mark_read`
- `whatsapp_prepare_reaction`
- `whatsapp_request_local_approval`
- `whatsapp_send_outcome`

Every tool accepts optional `account` (id or alias from `accounts.json`).

Chat listing omits last-message previews by default. Reading is intended not to
mark chats as seen. Sending passes `sendSeen: false`, reconciles missing library
return objects against the recent outbound cache, and returns presence to
unavailable. Rich E2E tests generate deterministic assets in memory and do not
read arbitrary user files or address-book contacts. Mark-read and reactions
require the same immutable native authorization. WhatsApp Web is an unofficial
and evolving surface, so verify this behavior after dependency or WhatsApp updates.

## Security Model

- Touch ID (or macOS login password) is required for every externally visible action:
  send, reaction, and mark-read.
- Rate limiting: 20 messages/hour, 100 messages/day, 3-second cooldown.
- No chat history stored locally.
- No TCP listener; Unix socket with mode 0600.
- Reading chats never requires approval.

```bash
./install-launchagent.sh install --account myphone
```

## Operations

Every script supports `--verbose` / `-v`.

- Status: `./install-launchagent.sh status`
- Version report: `node cli.mjs compatibility`
- Content-free upgrade test: `node cli.mjs compatibility-self-test`
- Approve a reviewed machine-local tuple: `node approve-baseline.mjs --approve-current`
- Restart: `./install-launchagent.sh restart`
- Stop: `./install-launchagent.sh stop`
- Remove autostart: `./install-launchagent.sh remove`
- Test: `npm run check`

All dependency installs use `npm ci --ignore-scripts` against the committed
lockfile. There is no automatic dependency update. Runtime or lockfile drift
blocks chat content and sends until the local tuple is explicitly re-approved.

Removing the LaunchAgent intentionally preserves linked-device credentials. To
fully revoke access, remove the linked device from the phone first, stop the
service, and then move `~/.local/share/whatsapp-agent` to Trash.
