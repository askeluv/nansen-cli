---
"nansen-cli": patch
---

`nansen schema` now describes the `bridge` command group — its three subcommands, their options, and the supported routes — so agents driving the CLI off the schema can discover it.

The mutating `perp` subcommands (`order`, `cancel`, `close`, `leverage`, `transfer`, `approve-builder-fee`) now declare `submitsTo: "https://api.hyperliquid.xyz/exchange"` in place of an `endpoint`, which is where they actually send a signed action, alongside an `apiEndpoints` list of the Nansen routes each one reads for compliance screening, market metadata and builder-fee status. Read-only subcommands keep their `endpoint` unchanged.
