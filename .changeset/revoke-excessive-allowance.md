---
"nansen-cli": minor
---

`trade execute` now revokes an existing on-chain ERC-20 allowance before
re-approving when it is more than 10x the current trade's scoped amount, such
as a legacy unlimited approval or an allowance granted by another app. Most
trades are unaffected. Opt out with `--no-revoke-excessive-allowance`.
