---
"nansen-cli": patch
---

Harden perp and bridge command safety:

- `perp order`/`close` now reject an invalid `--side` instead of silently opening the opposite direction, and `perp leverage` rejects an invalid `--margin-type` instead of silently switching to isolated.
- Perp numeric args (`--size`, `--price`, `--leverage`, `--oid`) are validated as positive numbers, with specific error messages instead of a generic usage banner.
- `bridge execute` now refuses a quote that has already been executed, preventing an accidental double-bridge on retry.
