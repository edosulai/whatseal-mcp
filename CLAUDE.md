## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

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
