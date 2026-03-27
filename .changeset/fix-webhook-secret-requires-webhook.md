---
"nansen-cli": patch
---

fix(alerts): error when --webhook-secret is passed without --webhook

Previously, passing --webhook-secret with a non-webhook channel (e.g. --telegram)
silently discarded the secret with no warning. The alert was created successfully
but without any signing, giving the false impression that the secret was active.

Now throws an actionable error: "--webhook-secret requires --webhook".
