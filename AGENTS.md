## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## whatseal skill

Bundled at `skills/whatseal/SKILL.md`. `whatseal setup` / `whatseal install-skill`
(also run by `install-launchagent.sh install` and the Node MCP entry) copies it to
user-global agent skill dirs, including Hermes (`~/.hermes/skills/whatseal/`).
When the user types `/whatseal` or asks about WhatsApp inbox, digest, reply, send,
or pairing, follow that skill before improvising. On Hermes, attach MCP with
`printf 'Y\n' | hermes mcp add whatseal --command npx --args -y --args whatseal --args mcp`
(from a checkout: `mcp-wrapper.sh`). Verify `hermes mcp list` and treat tools as
`mcp_whatseal_whatsapp_*`.

## Bag-safe power policy (built-in)

- Default ON inside this tool (not a dotfiles guard). `LOCK_POWER_GUARD=1`.
- On screen lock or lid close: pause/stop Chrome + polling/media hot path, set `paused_by_lock=true`.
- On unlock + lid open: resume only if this guard paused the backend.
- No caffeinate / prevent-sleep. Do not add centralized lock guards in other repos for this tool.
- Status: `node cli.mjs status` exposes `paused_by_lock` and `lockPower`.

## Browser memory policy (built-in)

- Contract shared with instaseal (identical names):
  - `BROWSER_POLICY=idle|on_demand|always` (default `on_demand`)
  - `IDLE_CHROME_MS` default `900000` (15m); `0` = never idle-close
  - Status: `chromeAlive`, `browserPolicy`, `idleChromeMs`, `idleForMs`, `lastRpcAt`
  - Cold phase: `idle_cold` (legacy readers may still see aliases)
- Node + Unix control socket stay up; Chrome is destroyed on idle and recreated on next WA RPC (`ensureBrowser` / `ensureReady`).
- `idle_cold` is not a stopped backend. First WA RPC after idle can take up to ~3 minutes. Use `whatsapp_wait_ready` / `node cli.mjs wait-ready` — do not start extra accounts or scan a new QR.
- `paused_by_lock` always wins over `idle_cold`. No caffeinate / prevent-sleep.
- Soft documentation cap: `MAX_HOT_BROWSERS=1`. Do not multi-profile one Chromium as the first step.
- Health poll while warm: ~90s. Auto-accept / call-bot OFF by default. Stop unused accounts instead of leaving warm Chrome.
- Legacy env alias still accepted: `BROWSER_IDLE_MS` → `IDLE_CHROME_MS`.

## Public repo hygiene

This repo may become public. Commits, commit messages, tags, and git history are visible forever. `.gitignore` only protects the next commit. A clean working tree is not a clean history.

Never commit live identity or machine-local state:
- secrets, tokens, API keys, `.env`, credentials, session/auth dirs
- real phone numbers, emails, home paths (`/Users/...`), hostnames, internal URLs
- generated caches, build output, editor/vendor skill folders, local graphs, logs

Public docs and tests use fake placeholders only. Copy from `*.example` files. Do not put live ids, real names of private accounts, or personal paths back into comments, fixtures, or commit messages.

Before every commit:
1. Check `git status`. Ignored local files must stay untracked.
2. Do not stage generate, cache, or vendor folders even if they look dirty.
3. Scan the staged diff for secrets, personal identifiers, and absolute local paths.

If a secret already landed in git, say so and wait for an explicit history-rewrite request. Do not force-push on your own.

Do not start extra services, mint pairing/auth artifacts, or touch live user accounts unless the user asked. In chat, use aliases — not raw personal identifiers.
