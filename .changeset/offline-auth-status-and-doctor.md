---
"nansen-cli": minor
---

Add `nansen auth status` and `nansen doctor`. `auth status` is fully offline: it reports whether an API key is configured and where it comes from (env var vs config file, masked), the active base URL, x402 wallet readiness, and OS keychain availability. `doctor` runs health checks over the whole setup — Node version, config file validity and permissions, wallet storage and password hygiene (flags the insecure `.credentials` file), keychain availability, Privy env credentials, caches, and telemetry — with an actionable fix per finding, plus a safe unauthenticated connectivity probe (no credits consumed; skip it with `--offline`). `--json` returns machine-readable checks.
