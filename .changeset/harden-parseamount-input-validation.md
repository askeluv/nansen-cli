---
"nansen-cli": patch
---

Harden `parseAmount` input validation: reject negative amounts wrapped in whitespace (previously silently miscalculated), and reject non-numeric or malformed inputs (e.g. `abc`, empty string, `1.`, `.5`) with a clear error instead of throwing a raw error or silently returning `0`.
