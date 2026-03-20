---
"nansen-cli": patch
---

Add `--webhook <url>` channel flag to `alerts create` and `alerts update`.

Allows alerts to be delivered to any HTTP/HTTPS endpoint via POST, alongside
the existing `--telegram`, `--slack`, and `--discord` channels.
