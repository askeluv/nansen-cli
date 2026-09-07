---
"nansen-cli": patch
---

Security: `nansen mcp verify` no longer sends a saved API key (from `nansen login` / `NANSEN_API_KEY` / config) to a custom `--url` without explicit consent. Forwarding a saved key to a non-default URL now requires `--send-api-key`, and no key is ever sent over plain HTTP to a non-loopback host. An inline `--api-key` is unaffected.
