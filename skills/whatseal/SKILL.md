---
name: whatseal
description: "Use for WhatsApp inbox, unread digest, chat recap, search, reply, send, pairing, or WhatsApp MCP readiness. Sealed WhatsApp for local AI agents — reads are free; every send, quote-reply, reaction, or mark-read needs Touch ID."
---

# /whatseal

Sealed WhatsApp MCP — a local linked-device WhatsApp Web session for AI agents.
Reading chats is free. Every externally visible action is sealed until Touch ID
or the macOS login password.

Prefer MCP tools when they are available. The CLI is `node cli.mjs` from the
whatseal-mcp checkout. Do not invent chats, messages, or send receipts.

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

1. Call `whatsapp_doctor` or `whatsapp_list_accounts` (preferred first call in a new chat).
2. If `code=IDLE_COLD`: Chrome is down on purpose. Call `whatsapp_wait_ready`
   (`timeoutSec=180`) then retry the read. Do **not** start extra accounts or scan a QR.
3. If `code=PAUSED_BY_LOCK`: the laptop is locked or the lid is closed. Tell the
   user to unlock. Do not caffeinate / prevent-sleep.
4. If stopped or unpaired: show the returned `userMessage` / start or pair steps.
   Do not run start/install/QR unless the user asked.
5. If pairing was explicitly requested: `whatsapp_qr` → user scans
   **WhatsApp → Settings → Linked Devices → Link a Device** → `whatsapp_wait_ready`.

`idle_cold` is not a stopped backend. The Unix socket stays up; the first WhatsApp
RPC after idle can take up to ~3 minutes.

### Step 2 — Reads are free

- Inbox watch: `whatsapp_unread_digest` (default previews on, `markRead=false`).
- Listing chats omits last-message previews unless the user asked for them.
- `whatsapp_read_messages` includes quoted-message id/body when present.
- Duplicate display names can exist. Resolve by chat **id**, never by name alone.
- In chat with the user, use aliases — not raw phone numbers or personal identifiers.

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

- Do not start extra WhatsApp accounts, mint pairing artifacts, or leave a second
  Chrome warm. Soft cap: one hot browser.
- Do not commit `accounts.json`, auth/session dirs, QR files, logs, or home paths.
- Public docs and fixtures use placeholders only (`alpha` / `beta`, `work` / `personal`).

## What whatseal is for

Local, bag-safe WhatsApp for the same Mac user who unlocked the session. Node +
control socket stay up; Chrome idles down. Agents recap, search, and draft;
the human seals every outbound action.
