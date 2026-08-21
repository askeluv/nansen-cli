---
"nansen-cli": minor
---

Add `nansen mcp install <client>` and `nansen mcp verify <client>` (Cursor first). `install` merges a native url+headers Nansen entry into the client's `mcp.json` using the saved login key (or `--api-key`), preserves other configured servers, refuses to clobber invalid JSON, and restricts the file to owner-only permissions. `verify` proves the endpoint with a streamable-HTTP initialize handshake and — because the handshake succeeds even unauthenticated — validates the configured key with a credit-free account check.
