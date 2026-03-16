---
name: nansen-holder-concentration
description: "Is this token controlled by a few coordinated wallets? Holder concentration, wallet clustering, and CEX same-day funding detection for memecoin due diligence."
---

# Holder Concentration

**Answers:** "Is this token distributed, or do connected wallets control it?"

## Cost

| Mode | Phases | Calls |
|---|---|---|
| Fast | 1 | ~103 |
| Standard | 1 + 2 | ~203 |
| Full | 1 + 2 + 3 | ~223 |

State mode and call estimate before running. Default: Fast. Standard recommended for memecoin entry checks.

---

## Phase 1 — Concentration Snapshot (~103 calls, mandatory)

```bash
TOKEN=<address> CHAIN=<ethereum|solana|base|...>

# Step 0: token metadata (1 call)
nansen research token info --token $TOKEN --chain $CHAIN
# → name, symbol, creation_date, deployer
# Compute token_age_days = today - creation_date

# Step 1: top 100 holders (1 call)
nansen research token holders --token $TOKEN --chain $CHAIN --limit 100
# → address, address_label, value_usd, ownership_percentage, balance_change_24h/7d/30d
```

**Validate:** `actual_count = len(data)`. If `actual_count < 100`, token has fewer holders than requested — adjust top-N thresholds proportionally. `actual_count < 20` = too sparse for reliable analysis.

**Precision:** If `ownership_percentage` rounds to 0.00% for all holders (large-supply tokens like USDC), compute manually: `token_amount / sum(all_token_amounts) * 100`.

Compute from **step 1 data only** (not step 2):
- Top 10 / 25 / 50 ownership % → sum `ownership_percentage`
- Fresh/unlabeled ratio: wallets with empty `address_label`
- SM/Fund count from `address_label` field

```bash
# Step 2: label all 100 holders (~100 calls + delay, sequential)
nansen research profiler batch --addresses "addr1,addr2,..." --chain $CHAIN --include labels,balance
# → address, labels[], balance_usd — does NOT return ownership_percentage
# labels[] = [{label, category, fullname, smEarnedDate}, ...] — NOT flat strings
# Match SM/Fund by scanning fullname or label fields in each object
```

**Optional shortcut** (1 call) — run after step 1:
```bash
nansen research token indicators --token $TOKEN --chain $CHAIN
# → Nansen Score, concentration signal, team_control signal
# If extreme concentration or team_control=high, skip manual concentration calc
```

**Auto-trigger rule:** If `unlabeled_ratio` (wallets with empty `labels[]`) > 40% after step 2, treat Phase 2 as **mandatory**.

---

## Phase 2 — First Funder Analysis (~100 calls, recommended)

Run on unlabeled/fresh wallets from Phase 1. Skip wallets already labeled (CEX, LP, Bot, project).

```bash
nansen research profiler related-wallets --address <holder_addr> --chain $CHAIN
# → address, address_label, relation (First Funder / Multisig Signer), block_timestamp, chain
```

Post-processing:
1. **CEX same-day:** `GROUP BY (funder_label, date(block_timestamp))` where funder_label contains CEX name (Binance, Coinbase, OKX, Kraken, Bybit, HTX, KuCoin). ≥2 holders funded same CEX same day → coordinated signal. Also check ≥3 holders from same CEX on **consecutive** days.
2. **Single controller:** `GROUP BY funder_address` (non-CEX). Same address funds ≥2 holders → possible single entity.

Note: `related-wallets` may return `Multisig Signer` instead of `First Funder` — adjust funder detection logic accordingly.

---

## Phase 3 — Connection Clustering (~20 calls, expert/opt-in)

Run on top 20 holders by `ownership_percentage`. Recommended: `--width 5` (default is 10 — reduce to avoid fan-out explosion).

```bash
nansen research profiler trace --address <holder_addr> --chain $CHAIN --depth 2 --width 5 --days 30
# → nodes[], edges[], stats.nodes_visited
# Monitor nodes_visited: if >50 nodes, reduce --width and rerun
```

Post-processing: build `{node_address: count_of_traces}`. Node in ≥3 traces = shared hub. Holders sharing a hub = likely same entity.

---

## Red Flag Decision Table

| Condition | Risk |
|---|---|
| Top 10 >50% | HIGH |
| Top 10 >70% | EXTREME |
| Fresh/unlabeled >40% in top 100 | HIGH |
| Zero SM/Fund in top 50 | MODERATE |
| ≥2 holders same CEX same day | MODERATE |
| ≥3 holders same CEX consecutive days | HIGH |
| Same non-CEX funder ≥2 holders | HIGH |
| Token age <7d AND top 10 >30% | EXTREME |
| Shared BFS hub across ≥5 top-20 holders | HIGH |

**Verdict** = highest matching row.

---

## Output Summary

```
TOKEN: <name> (<symbol>) | CHAIN: <chain> | Age: <N>d
DEPLOYER: <address>

CONCENTRATION (from step 1)
Top 10: XX.X% | Top 25: XX.X% | Top 50: XX.X%

WALLET QUALITY (top 100, from step 2)
SM/Fund: N | Fresh/unlabeled: N (XX%) | CEX wallets: N

FIRST FUNDER (Phase 2)
CEX same-day groups: N | Largest: N wallets from <CEX> on <date>
Single-controller groups: N | Largest: N wallets from <address>

CLUSTER (Phase 3, top 20)
Shared hubs: N | Connected holders: N of 20

VERDICT: CLEAN | MODERATE | HIGH | EXTREME
```

---

## Notes

- `profiler batch` loops sequentially (1 call/address + 1s delay). 100 addresses ≈ 100s.
- On Solana, `related-wallets` may return sparse results. Widen to `--days 90` if empty.
- If `holders` returns empty: token unindexed or too new — skip analysis.
- If all 100 holders are labeled: skip Phase 2 (`batch` with 0 unlabeled addresses returns empty, not an error).
- Rate limit: 100 `related-wallets` calls may trigger 429. Add `--delay 500` if errors appear.
- Wrapped/native tokens (SOL, WSOL) not supported by `token holders` — use specific SPL contract address only.
