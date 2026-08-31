---
"nansen-cli": minor
---

Add `nansen mcp install <client>` / `nansen mcp uninstall <client>` for one-step setup of the hosted Nansen MCP server (https://mcp.nansen.ai/ra/mcp) in Claude Code, Claude Desktop, and Cursor. Writes are merge-only and atomic (existing servers preserved, `.bak` backup on install and uninstall, refuses unparseable configs), use the API key from `nansen login` / `NANSEN_API_KEY`, never print the key, and support `--dry-run`.
