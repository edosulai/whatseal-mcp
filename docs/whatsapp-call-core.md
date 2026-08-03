# WhatsApp Call Core (Web / Linked Device)

Research notes (2026-08-02) on how WhatsApp **receives an incoming call** at the
protocol/core layer — not whatseal-invented endpoints.

**Scope:** WhatsApp Web rev shell `2.3000.1044298773` + `whatsapp-web.js@1.34.7`
as used by whatseal. Evidence from local `.wwebjs_cache`, downloaded
`static.whatsapp.net` JS (`N83Cxmw` / `e9Y2XNP`), and library inject code.

## Bottom line

| Question | Answer |
|----------|--------|
| Public HTTP endpoint for incoming call? | **None** |
| How does a call arrive? | Push **call offer signaling** on the existing device session |
| Web handler module | `WAWebHandleVoipCallOffer` |
| whatseal support? | **None** — daemon does not listen to `client.on('call')` |

## Planes (do not mix)

```text
1) Chat / call SIGNALING plane  (same session as chat)
   - offer / preaccept / accept / reject / terminate / relaylatency
   - E2E encrypted "enc" blob on offer
   - NOT a REST URL

2) Call MEDIA plane (after accept)
   - VoIP stack (Web: WASM / wavoip)
   - P2P and/or RELAY/TURN
   - Hosts often dynamic from signaling (not one hard-coded call DNS)

3) Asset / CDN plane
   - static.whatsapp.net → JS/CSS/WASM-related bundles
   - web.whatsapp.com → SPA origin
   - graph.whatsapp.com → GraphQL side APIs

4) Chat media plane (files/images)
   - separate media CDN (mmg/etc.) — not the voice/video stream
```

## Incoming-call path (WhatsApp Web)

1. Device already has an authenticated WhatsApp session (linked device / Web).
2. Server pushes a **call offer** over that session (stanza/IQ family `call`).
3. Client runs **`WAWebHandleVoipCallOffer`**, roughly in parallel:
   - QPL: `startVoipIncomingCallQpl` with `is_video`, `is_group`, `has_group_jid`, `is_offline`
   - **`WAWebVoipValidateAndDecryptEnc.validateAndDecryptEnc`**  
     points: `E2E_DECRYPT_START` → `E2E_DECRYPT_END`  
     failures: `[voip] handleIncomingCallOffer reject: enc retry`, enc parse error, max retry
   - **`WAWebVoipPeerTcToken.fetchPeerTcToken(peer_jid)`**  
     points: `TC_TOKEN_START` → `TC_TOKEN_END`
   - **`WAWebVoipStackInterface.getVoipStackInterface()`**  
     points: `STACK_RESOLVE_START` → `STACK_RESOLVE_END`
4. Optional group path: resolve `group_jid` name via `WAWebSchemaChat` + PN/LID via `WAWebLidMigrationUtils`.
5. Special case `silence_reason === "vc_wave_all"`:  
   `WAWebBackendApi.frontendSendAndReceive("generateCallLogOfferNotice", { callCreatorWid, offerTime, isVideo, silenceReason, ... })`  
   → **in-page frontend↔backend RPC**, not public REST.
6. Stack/UI: `WAWebVoipInit`, `WAWebVoipWebWasmLoader`, `WAWebVoipStackInterfaceImpl`, `WAWebVoipUi*`, `WAWebCallButtons`, call-log cells.
7. Client-side collection: **`WAWebCallCollection`** (Map of active call models).

### Offer object fields observed in handler

- `isVideoCall`, `group_jid`, `is_offline`, `peer_jid`, `t` (offer time), `silence_reason`
- encrypted payload **`enc`** (decrypt argument)
- related: peer TC token fetch by `peer_jid`

### Signaling children / actions (not HTTP paths)

| Action | Role |
|--------|------|
| `offer` | Incoming / setup |
| `preaccept` | Early media setup |
| `accept` | Accept call |
| `reject` | Reject (`call-id`, `call-creator`, `count`) |
| `terminate` | End call |
| `relaylatency` / relay bind | Relay setup / RTT metrics |

Conceptual reject stanza (session IQ, not REST):

```xml
<call id="..." from="ME" to="PEER">
  <reject call-id="CALL_ID" call-creator="PEER" count="0" />
</call>
```

WhatsApp Web internals used for reject (via inject / wwebjs):

- `WAWap.wap(...)` builds stanza
- `WADeprecatedSendIq.deprecatedCastStanza(stanza)` sends it on the session

## DNS / hosts — separated by plane, not “one call domain”

### What we observed in Web shell / scripts

| Host | Role | Same as chat signaling? |
|------|------|-------------------------|
| `web.whatsapp.com` | SPA origin | App shell |
| `static.whatsapp.net` | Code/assets (incl. VoIP JS deps) | CDN only |
| `graph.whatsapp.com` | GraphQL | Side API |
| `webtp.whatsapp.net` | Web TP | Not incoming-call URL |
| Session socket (via Web app) | Chat + **call signaling** | **Same plane as chat** |

### What we did **not** find hard-coded

- No fixed public `https://calls.whatsapp.com/...` or `/api/incoming-call`
- No hard-coded `stun:` / `turn:` URIs in the mined offer-handler scripts
- No permanent `voip.*.whatsapp.net` as “receive call” endpoint

Media-call hosts (relay/TURN) are expected to be **allocated dynamically** during
setup; static string mining alone will not list them.

### Mental model

```text
DNS / host
├─ web.whatsapp.com           → SPA
├─ static.whatsapp.net        → code (VoIP JS/WASM loader deps)
├─ graph.whatsapp.com         → graphql side
├─ session (chat plane)       → chat + CALL SIGNALING (offer/reject/…)
├─ media CDN (mmg/etc.)       → chat file media
└─ P2P / TURN relay (dynamic) → call audio/video
```

**Signaling call shares the chat session. Media call is a separate plane.**

## whatsapp-web.js bridge (library only)

Library version in whatseal: **1.34.7**.

| Piece | Detail |
|-------|--------|
| Event name | `Events.INCOMING_CALL = 'call'` (JSDoc sometimes says `incoming_call`) |
| Hook | Monkey-patch `WAWebCallCollection` internal `Map.set` → `window.onIncomingCall` |
| Node emit | `client.emit('call', Call)` |
| Structure | `src/structures/Call.js` |
| Methods | **`reject()` only** — no `accept()` in this version |
| Message type | `CALL_LOG = 'call_log'` = history message type, **not** live ring |

`Call` fields mapped by library:

| Field | Source |
|-------|--------|
| `id` | `data.id` |
| `from` | `data.peerJid` |
| `timestamp` | `data.offerTime` |
| `isVideo` | `data.isVideo` |
| `isGroup` | `data.isGroup` |
| `fromMe` | `data.outgoing` |
| `canHandleLocally` | `data.canHandleLocally` |
| `webClientShouldHandle` | `data.webClientShouldHandle` |
| `participants` | `data.participants` |

Example (library, not whatseal):

```js
client.on('call', async (call) => {
  await call.reject(); // optional
});
```

## whatseal product surface (explicit non-support)

Daemon listeners today: `qr`, `authenticated`, `ready`, `message_ack`,
`auth_failure`, `change_state`, `disconnected`.

**No** `client.on('call', ...)`.

HTTP API (internal ports / gateway): `/api/status`, `/api/me`, `/api/qr`,
`/api/chats`, `/api/messages/:chatId`, `/api/media/:messageId`, `/api/send`.

**No** `/api/call` or call MCP tools.

Wiki historically said “No call support / not accessible via web protocol” —
more precise: Web **does** surface call offers via VoIP modules; **whatseal
does not expose** them, and full accept/media is constrained (wwebjs reject-only;
media stack is separate WASM/VoIP path).

## Core modules (Web)

- `WAWebHandleVoipCallOffer` — incoming offer entry
- `WAWebVoipValidateAndDecryptEnc` — E2E decrypt `enc`
- `WAWebVoipPeerTcToken` — peer token
- `WAWebVoipStackInterface` / `Impl` / Windows variant
- `WAWebVoipInit`, `WAWebVoipWebWasmLoader`
- `WAWebVoipIncomingCallQpl` — telemetry points
- `WAWebCallCollection` — active calls map
- UI: `WAWebVoipUi*`, `WAWebCallButtons`, `WAWebCallLogIncomingCell`, Calls tab flows
- Fieldstats enums: transport type, relay bind, term reason, preaccept/accept fail codes, etc.

## Evidence artifacts (local)

- `.wwebjs_cache/2.3000.1044298773.html` (and sibling rev) — module names + rsrcMap
- Downloaded scripts (research TMP): offer-related `N83Cxmw.js`, telemetry/stack `e9Y2XNP.js`
- `node_modules/whatsapp-web.js/src/Client.js` — `onIncomingCall` + Map patch
- `node_modules/whatsapp-web.js/src/structures/Call.js`
- `node_modules/whatsapp-web.js/src/util/Injected/Utils.js` — `rejectCall` stanza

## Gaps / next proof steps

- Live network capture during a real call (ICE candidates, relay hostnames)
- Android native path (not Web) if phone-primary behavior differs
- Whether Web can fully accept + media in all product configurations

## Related product docs

- `graphify-out/wiki/limitations.md` — product boundaries
- `RISK-CONTROLS.md` — safety posture (calls not in agent surface)
