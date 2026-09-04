---
"nansen-cli": patch
---

Fix `nansen alerts create`/`update` silently dropping numeric range filters (`--usd-min/max`, `--market-cap-min/max`, `--fdv-min/max`, `--token-amount-min/max`, `--token-age-min/max`, and the `--inflow/outflow/netflow-*-min/max` flags) instead of rejecting bad input. These flags were converted with plain `Number(val)`, so a typo or garbage value (e.g. `--usd-min abc`) became `NaN`, which `JSON.stringify` silently turns into `null` in the request body — the alert would get created without the filter the user thought they'd set, with no error at any point. `--*-min`/`--*-max` now reject non-numeric input with a clear `Invalid --<flag> "<value>": must be a number` error; valid negative values (e.g. `--netflow-1h-min -5000` for a net-outflow filter) are unaffected.
