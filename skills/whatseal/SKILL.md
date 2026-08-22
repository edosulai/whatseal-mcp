---
name: whatseal
description: "Use for WhatsApp inbox, unread digest, chat recap, search, reply, send, pairing, or WhatsApp MCP readiness. Sealed WhatsApp for local AI agents — reads are free; every send, quote-reply, reaction, or mark-read needs Touch ID."
---

# /whatseal

Sealed WhatsApp MCP — a local linked-device WhatsApp Web session for AI agents.
Reading chats is free. Every externally visible action is sealed until Touch ID
or the macOS login password.

Prefer MCP tools when they are available. The CLI is `whatseal` (`npx -y whatseal`)
or `node cli.mjs` from a checkout. Do not invent chats, messages, or send receipts.
On Hermes Agent, MCP tools show up two ways:
- native prefix `mcp_whatseal_whatsapp_*`
- desktop deferred `mcp__whatseal__whatsapp_*` (double underscore) via
  `tool_describe` / `tool_call`

If neither skill nor MCP is attached, tell the user to run
`whatseal setup` (or `node cli.mjs install-skill` from a checkout) then
`printf 'Y\n' | hermes mcp add whatseal --command npx --args -y --args whatseal --args mcp`
(non-TTY: the CLI prompts “Enable all tools?” and cancels on EOF unless you pipe `Y`).
From a git checkout, `mcp-wrapper.sh` is the same Node entry.
Verify with **both** `hermes mcp list` and `hermes config get mcp_servers`.

Config persist ≠ this chat has the tools. After a successful add:
1. `setup_mcp(server='whatseal', action='enable')` injects them into the
   **current** desktop session (catalog `install` cannot attach a local
   stdio wrapper).
2. If enable is unavailable, restart Hermes / `/reload-mcp`.

## Usage

```
/whatseal                                 # doctor + default-account status
/whatseal digest                          # unread inbox watch (never marks read)
/whatseal chats                           # list chats (no last-message preview)
/whatseal read <chat-id-or-exact-name>    # recent messages (includes quoted ids)
/whatseal search "<query>"                # search; pass --chat to scope
/whatseal reply <chat> <message-id> <text>  # prepare quote-reply — do not send
/whatseal send <chat> <text>              # prepare send — do not send
```

MCP equivalents: `whatsapp_doctor`, `whatsapp_unread_digest`, `whatsapp_list_chats`,
`whatsapp_read_messages`, `whatsapp_search_messages`, `whatsapp_prepare_reply`,
`whatsapp_prepare_send`. Full catalog: `references/tools.md`.

## What You Must Do When Invoked

If the user asked `/whatseal --help` or `/whatseal -h` with no other arguments,
print the `## Usage` block above verbatim and stop.

Follow these steps in order. Do not skip them.

### Step 1 — Readiness (always first)

1. Call `whatsapp_list_accounts` (preferred) or `whatsapp_doctor`. Doctor
   without `account=` diagnoses the **default** only — another account can
   be ready while default is stopped.
2. Do not trust “should already be on”, a stale `status.json`, or
   `launchctl` showing the job. Ready means live `ready: true` + control
   socket present. `launchagent=loaded` / `state=spawn scheduled` with
   `socket=missing` is **not** ready.
3. If `code=IDLE_COLD` **and** the Unix socket exists: Chrome idled on
   purpose. Call `whatsapp_wait_ready` (`timeoutSec=180`) then retry.
   Do **not** start extra accounts or scan a QR.
4. If `code=PAUSED_BY_LOCK`: the laptop is locked or the lid is closed.
   Tell the user to unlock. Do not caffeinate / prevent-sleep.
5. Stopped ≠ idle. `launchagent=not-loaded` + missing socket, or
   `status.json` `phase=stopping` / `IDLE_COLD` with a stale pid and
   `canWake=false`, means the daemon is down. `wait_ready` cannot wake
   it. If the user asked to start it:
   `./install-launchagent.sh start --account ID` (always pass an action
   **and** `--account` — bare `./install-launchagent.sh` can hang).
   Status right after start may still say `socket=missing` /
   `phase=starting`; wait a few seconds, then `whatsapp_wait_ready`.
6. If unpaired: show the returned `userMessage`. Do not run
   start/install/QR unless the user asked.
7. If pairing was explicitly requested: `whatsapp_qr` → user scans
   **WhatsApp → Settings → Linked Devices → Link a Device** →
   `whatsapp_wait_ready`.

`idle_cold` is not a stopped backend **when the socket is up**. The first
WhatsApp RPC after idle can take up to ~3 minutes. Each account has its
own LaunchAgent; the one-hot-browser cap is per daemon, not “only one
account on the machine”.

### Step 2 — Reads are free

- Inbox watch: `whatsapp_unread_digest` (default previews on, `markRead=false`).
- Listing chats omits last-message previews unless the user asked for them.
- `whatsapp_read_messages` includes quoted-message id/body when present.
- Duplicate display names can exist. Resolve by chat **id**, never by name alone.
- In chat with the user, use aliases — not raw phone numbers or personal identifiers.
- **Media is never downloaded** (MCP and CLI). `hasMedia: true` + empty
  `body` is the image. Search quoted-image `body` is often a **truncated
  JPEG thumbnail** (`/9j/…`, ~300–400 bytes) — not the screenshot.
- HTTP `GET /api/media/:id` is opt-in (`WHATSEAL_WEB_API=1` /
  `WHATSAPP_HTTP_API=1`). Port = `30000 + last 4 digits` of the account
  (0100 → 30100). Default is off; refused `curl` is expected.
- Chrome is `--headless=new --remote-debugging-pipe` — no DevTools port,
  no window for `computer_use`.
- Native WhatsApp.app `ChatStorage.sqlite` is a **different account**
  than a Whatseal linked-device session. Empty desktop hits ≠ no media
  on the Whatseal account.
- Do not scrape Chrome `Cache_Data` for a portrait JPEG and treat it as
  the user's screenshot. Report caption + message id instead.

### Step 3 — Writes are two-phase + Touch ID

Sends, quote-replies, reactions, and mark-read:

1. `prepare_*` (quote-reply: `whatsapp_prepare_reply` with the exact message id).
2. Show the exact target + preview in chat.
3. Wait for an explicit OK from the user.
4. `whatsapp_request_local_approval` (Touch ID / macOS password).
5. On timeout or uncertainty: `whatsapp_send_outcome` first. Never re-prepare a
   duplicate send blindly.

Never claim a message was sent unless approval / `send_outcome` reports success.

### Step 4 — Do not freelance the machine

- Do not start extra WhatsApp accounts, mint pairing artifacts, or leave a
  second Chrome warm **unless the user asked**. Soft cap is one hot Chrome
  **per account daemon**, not one account on the Mac.
- **Instaseal is a different repo.** Instagram account ids belong there, not
  in whatseal. Filter process listings by `whatseal-mcp/` — both daemons are
  named `daemon.mjs`.
- Preferred MCP attach is `npx -y whatseal mcp`, not a second checkout copy.
  From a git checkout, `mcp-wrapper.sh` is the same Node entry (`bin/whatseal-mcp.mjs`).
  After pull: restart LaunchAgents per account. Stdio MCP respawns next session.
  Use **`whatseal@2.0.3` or later**. `2.0.0`–`2.0.2` are deprecated (`npx`
  install failed: git dep / nested `puppeteer` chrome-headless-shell
  postinstall). Prove `npx` from `/tmp`, never from this checkout. The
  published tree vendors `whatsapp-web.js` against `puppeteer-core` and
  launches system Chrome (`WHATSAPP_CHROME_PATH` or platform candidates).
- Do not commit `accounts.json`, auth/session dirs, QR files, logs, or home paths.
- Public docs and fixtures use placeholders only (`alpha` / `beta`, `work` / `personal`).

## What whatseal is for

Local, bag-safe WhatsApp for the same Mac user who unlocked the session. Node +
control socket stay up; Chrome idles down. Agents recap, search, and draft;
the human seals every outbound action.
