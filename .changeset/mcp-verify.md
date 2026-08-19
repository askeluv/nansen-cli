---
"nansen-cli": minor
---

Add `nansen mcp verify [client]` — authenticated verification of the MCP setup. Makes one real MCP data call (`tools/call` of `token_info`) against the hosted server, because `tools/list` succeeds without a key and a broken credential otherwise only surfaces on first use. Maps every failure (no key sent, invalid key, rate limit, server error, connectivity/timeout) to an actionable next step, never prints the key, and refuses redirects. With a client argument it verifies the key actually installed in that client's config (rejecting entries that drift from what `nansen mcp install` writes, before any network call); without one it verifies the `nansen login` / `NANSEN_API_KEY` credential. `nansen mcp install` now points to it as the final setup step.
