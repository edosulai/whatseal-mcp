# Known-Good Compatibility Records

This file records combinations that passed acceptance on at least one machine.
It is informational and never authorizes another machine. Each Mac maintains its
own private approval tuple under `~/.local/state/whatsapp-agent/`.

## Template

| Component | Accepted value |
| --- | --- |
| WhatsApp Web | `2.3000.x` |
| Chrome | `150.x.x.x` |
| Node.js | `v22+` |
| Platform | `darwin-arm64` |
| Backend | `1.0.0` |
| `whatsapp-web.js` package version | `1.34.7` |
| `whatsapp-web.js` source | Commit `1780711a1c86dfeca7c5ba6a66f950eac93dde28` |
| `package-lock.json` SHA-256 | *(machine-specific)* |
| Backend startup source SHA-256 | *(machine-specific)* |
| Installed dependencies SHA-256 | *(machine-specific)* |
| Message helper SHA-256 | *(machine-specific)* |
| Baseline helper SHA-256 | *(machine-specific)* |
| MCP SDK | `1.29.0` |
| `qrcode` | `1.5.4` |
| Zod | `4.4.3` |

Acceptance evidence (all must pass before recording):

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

- WhatsApp Web can emit several `authenticated` events and leave
  `window.WWebJS` partially injected during main-frame transitions.
- Recovery coalesces listener installation, waits for the Stream model, and
  reinstalls upstream `LoadUtils` only after the document is stable.
- Full upstream `getChats()` can fail with minified `r` on LID/IndexedDB model
  serialization. The backend uses minimal scalar serializers and avoids group
  metadata/media loading for list and read operations.
- This record proves compatibility on one machine; it is not a hard security
  boundary against arbitrary code already running as the same macOS user.
