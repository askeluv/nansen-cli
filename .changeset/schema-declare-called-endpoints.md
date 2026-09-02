---
"nansen-cli": patch
---

Declare the API routes `alerts`, `account`, `web` and `agent` already call in `src/schema.json`. The schema is what shell completions, `--help` and docs tooling read, so eight routes the code requests were invisible to them (and to the API/MCP/CLI parity check).
