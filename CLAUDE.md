## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Public repo hygiene

Repo is public. Never commit `accounts.json`, live phone/account ids, personal emails, or generate dirs (`graphify-out/`, `.claude/`, `.codex/`, `.wwebjs_cache/`). Docs and tests use `alpha` / `beta` only. A clean tree is not a clean history — do not force-push unless asked. Full rules: `AGENTS.md`.
