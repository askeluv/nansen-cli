---
"nansen-cli": patch
---

Telemetry now creates `~/.nansen` with mode 0700 and writes its id/session files with mode 0600, matching every other module that writes to that directory. Previously these were the only writes there that used default permissions, so when they were the first to create the directory (for example when authenticating with `NANSEN_API_KEY` instead of `nansen login`) it was left group- and world-readable.
