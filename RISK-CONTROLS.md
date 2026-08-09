# WhatsApp Agent Risk Controls

This document is the operational risk register for the local WhatsApp linked
device backend. The integration remains unofficial: controls reduce exposure but
cannot turn WhatsApp Web automation into a supported WhatsApp API.

## Control summary

| Risk | Preventive controls | Detection | Recovery | Residual risk |
| --- | --- | --- | --- | --- |
| WhatsApp Web changes break the client | Machine-local last-known-good version tuple; content and send gate on any drift; exact dependency lock | `compatibility` and content-free `compatibility-self-test` | Test changed tuple without content, then explicitly promote it | WhatsApp can make a server-side change that requires new code or pairing |
| WhatsApp restricts the account | No auto-replies; no bulk-send tool; one immutable native preview and LocalAuthentication per send; single concurrent approval; 3-second cooldown; 20/hour and 100/day ceilings | Durable outcome ledger and send state | Stop the daemon and revoke the linked device from the phone | Any unofficial automation may violate WhatsApp policy regardless of volume |
| Third-party dependency compromise | Direct versions pinned; `whatsapp-web.js` pinned to a full commit; lockfile and integrity hashes are part of the approved tuple; `npm ci --ignore-scripts`; no automatic update | Lockfile SHA-256 drift gate; `npm audit`; source/commit shown in compatibility report | Stop daemon, review diff/advisories, rebuild from reviewed lockfile | Registry, GitHub, npm, Chrome, and transitive packages remain external trust dependencies |
| Linked-device profile or control-file theft | Dedicated profile; `0700` directories; `0600` socket/files; no TCP API by default; optional Web sends retain native approval; Puppeteer pipe instead of DevTools port; QR removal | Permission checks, default no-port E2E, health checks, source/dependency/helper hashes | Revoke Linked Device on phone, stop daemon, move profile/state to Trash, pair again | A same-UID process can read profile data and replace baseline/helper/code; explicitly enabled loopback Web/call-audio routes add local attack surface; use a separate macOS account or privileged signed broker for a hard boundary |
| Silent browser/runtime updates | Version tuple includes WhatsApp Web, Chrome, Node, dependency source/integrity, and full lockfile SHA-256 | Every content or send request checks drift live | Content-free self-test, explicit baseline promotion | A compatible-looking version can still contain behavior changes not covered by tests |

## Compatibility gate

The approved tuple is machine-local at:

`~/.local/state/whatsapp-agent/compatibility-baseline.json`

The latest observed report is machine-local at:

`~/.local/state/whatsapp-agent/compatibility-snapshot.json`

The tuple contains:

- WhatsApp Web version
- Chrome runtime version
- Node runtime version
- `whatsapp-web.js` source, resolved commit, and integrity hash
- full `package-lock.json` SHA-256
- backend source SHA-256
- complete installed `node_modules` tree SHA-256, calculated at daemon startup
- message-approval helper binary SHA-256
- baseline-approval helper binary SHA-256
- MCP SDK, QR, and Zod versions

Any mismatch blocks chat listing, reading, search, draft preparation, and send
approval. Status, compatibility reporting, the content-free self-test, security
audit, and existing send-outcome lookup remain available.

Baseline promotion is deliberately not an MCP tool. It requires a local command
with an explicit flag, an immutable native version preview, and Touch ID or the
macOS login password:

`node approve-baseline.mjs --approve-current`

The native approval dialog prevents an agent from approving drift through the
supported MCP/CLI path. It is **not** a hard boundary against arbitrary code
already running as the same macOS user: same-UID code can replace user-owned
baseline/helper/backend files. Use a dedicated macOS service account or a
root-owned, code-signed broker when that attacker model must be resisted.

The command requires:

1. backend phase `ready`;
2. WhatsApp connection state `CONNECTED`;
3. required Stream, collection, read, and send functions present;
4. content-free test output (count only; no IDs, names, previews, or bodies);
5. Unix socket mode `0600`.

Run `whatsapp_security_audit` or `node cli.mjs security-audit` to re-check
FileVault, path ownership/modes, native helper permissions, Chrome's pipe
transport, and absence of a backend TCP listener without reading chat content.
The listener check intentionally fails when the optional Web API or tokenized
compressed call-audio server is enabled.

## Update procedure

1. Do not update dependencies automatically.
2. Record the current `compatibility` output.
3. Review upstream release notes, commits, advisories, and lockfile diff.
4. Run `npm ci --dry-run --ignore-scripts` and `npm audit --omit=dev`.
5. Restart only the WhatsApp backend; never touch 9router.
6. Confirm the saved Linked Device restores without a QR.
7. Run `compatibility-self-test`. It must return no chat content.
8. Confirm socket/profile permissions and absence of TCP/DevTools listeners.
9. Review the changed version tuple.
10. Promote it locally with `approve-baseline.mjs --approve-current`.
11. Perform a user-authorized, narrowly scoped read test.
12. Test send only when the user explicitly requests a real message; never send a synthetic test message to a contact.

## Account-restriction controls

The backend cannot send autonomously:

1. An agent prepares an immutable target/body preview.
2. The user approves opening the local authorization prompt.
3. A native macOS dialog displays the immutable target and exact body.
4. LocalAuthentication requires Touch ID or the macOS login password.
5. Only one approval can run at a time.
6. Rolling limits and cooldown are checked before prepare, before authorization,
   and immediately before submission.
7. Ambiguous outcomes count toward rate limits to prevent retry storms.

These limits are safety ceilings, not a statement that sending up to those limits
is accepted by WhatsApp. The approval mutex is acquired before asynchronous
compatibility/rate checks, so only one supported approval flow can run at once.

## Privacy boundary

- Status and compatibility tools return no chat content.
- Chat listing omits last-message previews by default.
- Reading does not deliberately invoke `sendSeen`.
- The backend never invokes the media-download API.
- Content returned to an MCP client enters the selected model and IDE transcript.
- Use a local model when message content must not leave the Mac.
- FileVault should remain enabled for at-rest protection of user-owned runtime
  data. FileVault does not protect files from processes already running as the
  logged-in user.

## Hard-boundary option

For protection against terminal-capable agents or untrusted processes running as
the interactive user, run the backend under a dedicated non-admin macOS account
and expose only a narrowly permissioned broker, or implement a root-owned,
code-signed authorization service that verifies signed baseline/send records.
The current per-user LaunchAgent deliberately does not claim this boundary.

## Emergency stop and revocation

1. Stop the backend with `./install-launchagent.sh stop`.
2. On the phone, open **WhatsApp → Settings → Linked Devices** and log out the
   backend device.
3. Move `~/.local/share/whatsapp-agent` to Trash.
4. Move `~/.local/state/whatsapp-agent` to Trash after preserving only any audit
   evidence the user explicitly needs.
5. Re-pair only after the root cause is understood.
