---
name: nansen-holder-concentration
description: "Is this token controlled by a few coordinated wallets? Holder concentration, wallet clustering, and CEX same-day funding detection for memecoin due diligence."
---

# Holder Concentration

**Answers:** "Is this token distributed, or do connected wallets control it?"

---

## Phase 1 — Concentration Snapshot (~102 calls, sequential)

```bash
TOKEN=<address> CHAIN=<ethereum|solana|base|...>

# Step 1: top 100 holders (1 call)
nansen research token holders --token $TOKEN --chain $CHAIN --limit 100
# → address, address_label, value_usd, ownership_percentage, balance_change_24h/7d/30d

# Step 2: label all 100 in one CLI invocation — sequential under the hood, ~100 calls + delay
nansen research profiler batch --addresses "<addr1,addr2,...>" --chain $CHAIN --include labels,balance
# max 100 addresses per invocation; all 100 holders fit in one call
# → address, labels[], balance_usd
```

Compute locally (no extra calls):
- Top 10 / 25 / 50 ownership % (sum `ownership_percentage`)
- Fresh wallet ratio: wallets with label `fresh_wallet` or no labels
- SM/Fund count: labels containing `Smart Trader`, `Fund`

Red flags: top 10 own >50%; fresh wallet ratio >40% in top 100; zero SM/Fund labels in top 50.

---

## Phase 2 — First Funder Analysis (~100 calls, opt-in)

Run on all 100 holders. `related-wallets` is lightweight — no BFS fan-out.

```bash
nansen research profiler related-wallets --address <holder_addr> --chain $CHAIN
# → address, address_label, relation (First Funder / Multisig Signer), block_timestamp, chain
```

Post-processing:
1. CEX same-day: `GROUP BY (funder_label, date(block_timestamp))` where funder_label contains a CEX name (Binance, Coinbase, OKX, Kraken, Bybit, HTX, KuCoin). ≥3 holders → coordinated launch.
2. Single controller: `GROUP BY funder_address` (non-CEX). Same address funds ≥3 holders → one entity.

Red flags: ≥3 of 100 funded from same CEX same day; same non-CEX address funds ≥3 holders; cluster concentrated outside top 20 (positions 30-70).

---

## Phase 3 — Connection Clustering (~20 calls, opt-in, expensive)

Run only on top 20 holders by `ownership_percentage`. Hard cap: `--depth 2 --width 5`.

⚠️ Each trace fans out internally (depth 2 × width 5 = up to 31 nodes per seed). Keep width ≤5.

```bash
nansen research profiler trace --address <holder_addr> --chain $CHAIN --depth 2 --width 5 --days 30
# → nodes[], edges[], stats.nodes_visited
```

Post-processing: build `{node_address: count_of_traces_it_appears_in}`. Node in ≥3 traces = shared hub. Holders sharing a hub = likely same entity.

Red flags: ≥5 of top 20 share a common hub; shared hub is a deployer or team wallet.

---

## Output Summary

```
TOKEN: <address> | CHAIN: <chain>

CONCENTRATION
Top 10: XX.X% | Top 25: XX.X% | Top 50: XX.X%
Risk: LOW | MEDIUM | HIGH | EXTREME

WALLET QUALITY (top 100)
SM/Fund: N | Fresh/unlabeled: N (XX%) | CEX wallets: N

FIRST FUNDER (top 100)
CEX same-day groups: N | Largest: N wallets from <CEX> on <date>
Single-controller groups: N | Largest: N wallets from <address>

CLUSTER (top 20, depth 2)
Shared hubs: N | Connected holders: N of 20

VERDICT: CLEAN | MODERATE RISK | HIGH RISK | LIKELY COORDINATED
```

---

## Cost

| Mode | Phases | Calls |
|---|---|---|
| Fast | 1 | ~102 |
| Standard | 1 + 2 | ~202 |
| Full | 1 + 2 + 3 | ~222 |

Always state mode and call estimate before running. Default: Fast. Standard is recommended for memecoin entry checks.

---

## Notes

- `profiler batch` loops sequentially (1 call/address + 1s delay). 100 addresses ≈ 100s.
- `token holders` does not support native/wrapped tokens. Use the specific contract address.
- On Solana, `related-wallets` may return sparse results. Widen to `--days 90` if empty.
