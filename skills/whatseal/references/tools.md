# whatseal tools

Prefer MCP tools when the host has the `whatseal` server attached. CLI commands
run from the whatseal-mcp checkout: `node cli.mjs <command> [--account ID|alias]`.

Every MCP tool accepts optional `account` (id or alias from local `accounts.json`).
Omit it to use the configured default.

## Onboarding / readiness

| MCP | CLI | Notes |
| --- | --- | --- |
| `whatsapp_doctor` | `status` + saved-state guidance | Preferred first call |
| `whatsapp_list_accounts` | — | Discover ids / aliases / readiness |
| `whatsapp_status` | `status` | Socket-only; does not wake Chrome |
| `whatsapp_qr` | `qr` | Local PNG path only; user scans on the phone |
| `whatsapp_wait_ready` | `wait-ready [--timeout-sec N]` | RPC `wake` → `ensureReady`. Default 180s |

`whatsapp_status` / `whatsapp_compatibility` stay socket-only. Do not treat
`idle_cold` as stopped — use `wait_ready` instead of starting another account.

## Diagnostics

| MCP | CLI |
| --- | --- |
| `whatsapp_compatibility` | `compatibility` |
| `whatsapp_compatibility_self_test` | `compatibility-self-test` |
| `whatsapp_security_audit` | `security-audit` |

## Read (no Touch ID, never marks seen)

| MCP | CLI | Notes |
| --- | --- | --- |
| `whatsapp_unread_digest` | `digest [--limit N] [--no-preview] [--since TS]` | Inbox watch; default preview on |
| `whatsapp_list_chats` | `chats [--limit N] [--unread] [--include-preview]` | Preview off by default |
| `whatsapp_read_messages` | `messages <chat> [--limit N]` | Includes quoted id/body. **Never downloads media.** |
| `whatsapp_search_messages` | `search <query> [--chat ID_OR_NAME] [--limit N]` | |
| `whatsapp_message_status` | `message-status <message-id>` | |

## Write (two-phase + Touch ID)

| MCP | CLI |
| --- | --- |
| `whatsapp_prepare_send` | `prepare-send <chat> <text>` |
| `whatsapp_prepare_reply` | `prepare-reply <chat> <message-id> <text>` |
| `whatsapp_prepare_rich_test` | `prepare-rich-test <chat> <image\|document\|location\|contact\|sticker>` |
| `whatsapp_prepare_mark_read` | `prepare-mark-read <chat>` |
| `whatsapp_prepare_reaction` | `prepare-reaction <chat> <message-id> <emoji>` |
| `whatsapp_request_local_approval` | `request-approval <approval-id>` |
| `whatsapp_send_outcome` | `send-outcome <approval-id>` |

Quote-replies need the exact message id from read/search. Rich tests use
in-memory fixtures only — they do not read arbitrary user files.

## Agent skill install (this file)

| CLI | Notes |
| --- | --- |
| `install-skill [--platform P] [--project]` | Copy `skills/whatseal/` to agent skill dirs |
| `uninstall-skill [--platform P] [--project]` | Remove only the whatseal skill copy |

`./install-launchagent.sh install` and `mcp-wrapper.sh` run `install-skill`
so hosts pick up `/whatseal` without a manual copy. Default platforms:
copilot, claude, codex, agents, hermes.

Hermes also needs the MCP server attached once:

```bash
printf 'Y\n' | hermes mcp add whatseal --command /ABSOLUTE/PATH/TO/whatseal-mcp/mcp-wrapper.sh
hermes mcp list
hermes config get mcp_servers
```

Pipe `Y` — without a TTY the “Enable all tools?” prompt cancels and nothing is saved.
Verify persist with `hermes mcp list` **and** `hermes config get mcp_servers`.
Then either `setup_mcp(server='whatseal', action='enable')` in the current
desktop chat, or restart Hermes / `/reload-mcp`. Tools appear as
`mcp_whatseal_whatsapp_*` (native) or `mcp__whatseal__whatsapp_*` (desktop deferred).

`whatsapp_doctor` without `account=` diagnoses the default only. Use
`whatsapp_list_accounts` first when more than one account exists.
Stopped (`launchagent=not-loaded`, missing socket, stale `phase=stopping`)
is not `idle_cold`. Start with `./install-launchagent.sh start --account ID`.
