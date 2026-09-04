---
"nansen-cli": patch
---

Fix `nansen alerts list --limit`/`--offset` silently misbehaving on invalid or edge-case input. `--limit 0` and `--offset 0` were treated as "not set" (falsy check) and silently ignored instead of honored; a non-numeric value like `--limit abc` silently returned zero results (`Array.prototype.slice` coerces `NaN` to `0`) instead of erroring; and a negative `--offset` was silently accepted by `slice()`, which treats negative indices as "from the end" — returning the wrong records instead of rejecting the input. Both flags are now validated as non-negative integers, matching the strict-validation convention already used elsewhere in the CLI (e.g. `--slippage`), and throw a clear `INVALID_PARAMS` error otherwise.
