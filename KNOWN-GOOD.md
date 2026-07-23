# Known-Good Compatibility Records

This file records combinations that passed acceptance on at least one machine.
It is informational and never authorizes another machine. Each Mac maintains its
own private approval tuple under `~/.local/state/whatsapp-agent/`.

## 2026-07-20 — Apple Silicon Mac

| Component | Accepted value |
| --- | --- |
| WhatsApp Web | `2.3000.1043451071` |
| Chrome | `150.0.7871.125` |
| Node.js | `v26.0.0` |
| Platform | `darwin-arm64` |
| Backend | `1.0.0` |
| `whatsapp-web.js` package version | `1.34.7` |
| `whatsapp-web.js` source | Commit `1780711a1c86dfeca7c5ba6a66f950eac93dde28` |
| `package-lock.json` SHA-256 | `3637dd25b90262970d52011beb4edc9bd3f8a1492c24eb1bbc26fc6a756fca59` |
| Backend startup source SHA-256 | `899787a59314932af987eeb1ff6627a4d911a31f6c67848a9d107df74e667e4c` |
| Installed dependencies SHA-256 | `220cccd67180329a5e54753442784cdc3e834fcfc4a5bb2294520481cf2680cc` |
| Message helper SHA-256 | `6b3f9a239e714ec1e1ff6f5b05e57cc1fc9175d9e70d0ce09a41e70f5fc09fc5` |
| Baseline helper SHA-256 | `2da746a4b78eef6df4594bde28e5fe83de67fb4f2d3272ca0333d7824807dca3` |
| MCP SDK | `1.29.0` |
| `qrcode` | `1.5.4` |
| Zod | `4.4.3` |

Acceptance evidence:

- saved Linked Device restored without a new QR;
- backend reached `CONNECTED` and `ready`;
- QR artifacts were removed;
- control socket was `0600`;
- Chrome used Puppeteer pipe and exposed no DevTools TCP port;
- minimal scalar chat collection worked;
- list test returned chat metadata with no message previews;
- MCP chat-list integration worked without visible Chrome;
- native send gate compiled and requires macOS LocalAuthentication;
- baseline promotion displayed the immutable tuple and required macOS LocalAuthentication;
- backend source matched the source loaded at daemon startup;
- full installed dependency tree and both native helper binaries were attested;
- content-free security audit passed 9/9 checks, including FileVault;
- no synthetic message was sent during testing.

Compatibility notes:

- Current WhatsApp Web can emit several `authenticated` events and leave
  `window.WWebJS` partially injected during main-frame transitions.
- Recovery coalesces listener installation, waits for the Stream model, and
  reinstalls upstream `LoadUtils` only after the document is stable.
- Full upstream `getChats()` can fail with minified `r` on LID/IndexedDB model
  serialization. The backend uses minimal scalar serializers and avoids group
  metadata/media loading for list and read operations.
- This record proves compatibility on one machine; it is not a hard security
  boundary against arbitrary code already running as the same macOS user.
