## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Bag-safe power policy (built-in)

- Default ON inside this tool (not a dotfiles guard). `LOCK_POWER_GUARD=1`.
- On screen lock or lid close: pause/stop Chrome + polling/media hot path, set `paused_by_lock=true`.
- On unlock + lid open: resume only if this guard paused the backend.
- No caffeinate / prevent-sleep. Do not add centralized lock guards in other repos for this tool.
- Status: `node cli.mjs status` exposes `paused_by_lock` and `lockPower`.
