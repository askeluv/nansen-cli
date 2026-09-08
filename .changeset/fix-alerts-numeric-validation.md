---
"nansen-cli": patch
---

Fix `nansen alerts list --limit`/`--offset` and the numeric range flags on `nansen alerts create`/`update` (`--market-cap-min/max`, `--usd-min/max`, `--token-amount-min/max`, `--fdv-min/max`, `--inflow/outflow/netflow-*-min/max`, `--token-age-min/max`) silently accepting non-numeric input instead of erroring.

`--limit abc` returned an empty alert list (`Array.prototype.slice(0, NaN)` evaluates the end index as `0`), indistinguishable from genuinely having zero alerts. `--offset -2` silently returned the *last* 2 alerts (a negative `slice()` start counts from the end of the array) instead of erroring on an invalid pagination offset. A non-numeric range flag like `--market-cap-min notanumber` passed validation (`NaN != null` looks "set") but serialized to `{"min":null}` over JSON, silently creating the alert with that threshold disabled rather than the value the user typed.

All of these now throw a clear `--<flag> must be a number` / `must be a positive integer` / `must be a non-negative integer` error instead of silently producing a wrong result, matching the validation style already used by `--limit`/`--page` elsewhere in the CLI (`src/query-options.js`, `src/commands/research.js`).
