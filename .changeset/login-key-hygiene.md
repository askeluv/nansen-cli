---
"nansen-cli": patch
---

Credential hygiene: `nansen login` verification failures cannot relay the API
key, invalid-key remediation points at key management, and login guidance leads
with paths that avoid shell history. Every request that carries a credential —
API key, agent, limit-order JWT/X-API-Key, MCP verify, and Privy auth — now
refuses to follow HTTP redirects, so a credential can't be relayed to a redirect
target. Interactive password and API-key prompts stay masked (no cleartext echo)
even when stdout is redirected.
