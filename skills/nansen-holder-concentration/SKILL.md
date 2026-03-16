---
name: nansen-holder-concentration
description: "Is this token controlled by a few coordinated wallets? Holder concentration, wallet clustering, and CEX same-day funding detection for memecoin due diligence."
---

# Holder Concentration

**Answers:** "Is this token actually distributed, or do a few connected wallets control it?"

Use at low market caps (sub-$10M) before entry. Identifies: concentrated ownership, coordinated launches, sybil clusters, and fresh wallets funded from the same CEX on the same day.

---

## Phase 1 — Concentration Snapshot (2-3 calls, always run)

```bash
TOKEN=<address> CHAIN=<ethereum|solana|base|...>

# Step 1: Top 100 holders
nansen research token holders --token $TOKEN --chain $CHAIN --limit 100
# → address, address_label, value_usd, ownership_percentage, balance_change_24h/7d/30d

# Step 2: Batch label all 100 holders in one call (pipe addresses from step 1)
nansen research profiler batch --addresses "<addr1,addr2,...addr100>" --chain $CHAIN --include labels,balance
# → address, labels[], balance_usd — collapses 100 calls into 1-2
```

**Compute from output (no extra calls):**
- Top 10 ownership %: sum top 10 `ownership_percentage`
- Top 25 / top 50 ownership %: same
- Fresh wallet count: wallets with label `fresh_wallet` or no labels
- SM/Fund count: wallets labeled `Smart Trader`, `Fund`, etc.

**Concentration red flags:**
- Top 10 wallets own >50% → high concentration risk
- Top 25 wallets own >70% → extreme — likely coordinated
- Fresh wallet ratio in top 100 >40% → sybil signal
- Zero SM/Fund labels in top 50 → no quality money

---

## Phase 2 — Connection Clustering (≈20 calls, opt-in, depth 2)

**Run only on top 20 holders by ownership_percentage. Hard cap: depth 2, width 5.**

⚠️ Cost warning: ~20 API calls. Each trace fans out to depth 2 (up to 1 + 5 + 25 = 31 nodes per seed). With deduplication across seeds, real total is typically 50-150 unique nodes.

```bash
# Run for each of the top 20 holders (one at a time, deduplicate across runs)
nansen research profiler trace --address <holder_addr> --chain $CHAIN --depth 2 --width 5 --days 30
# → nodes[], edges[], stats.nodes_visited

# Collect all node addresses across all 20 traces.
# A node appearing in ≥3 different traces = shared hub = cluster signal.
```

**Clustering logic (post-processing):**
- Build a frequency map: `{node_address: count_of_traces_it_appears_in}`
- Nodes appearing in ≥3 traces are shared hubs
- Holders connected through the same hub = likely same entity or coordinated group
- Count: how many of the top 20 holders share at least one 2-hop connection

**Cluster red flags:**
- ≥5 of top 20 share a common hub address → coordinated cluster
- Shared hub is a deployer or team wallet → insider distribution

---

## Phase 3 — CEX Same-Day Funding Detection (≈20 calls, opt-in)

**Run on top 20 holders. Detects coordinated wallet creation funded from the same exchange.**

```bash
# Get first funder for each top 20 holder
nansen research profiler related-wallets --address <holder_addr> --chain $CHAIN
# → address, address_label, relation (First Funder / Multisig Signer), block_timestamp, chain
```

**For each holder, extract:**
- First Funder address + label (is it a CEX? e.g. Binance Hot Wallet, Coinbase)
- `block_timestamp` of first funding event

**CEX same-day logic (post-processing):**
- Group holders by: (funder_label, date(block_timestamp))
- If ≥3 holders funded from the same CEX label on the same calendar day → coordinated launch signal
- If the funder is NOT a CEX but the same address funds ≥3 holders → single controller signal

**Coordination red flags:**
- ≥3 top-20 holders funded from same CEX on same day → very likely coordinated
- Same non-CEX address is First Funder for multiple top holders → single entity controlling multiple positions
- All fresh wallets + same-day CEX funding + high concentration → textbook rug setup

---

## Output Summary Template

```
TOKEN: <address> | CHAIN: <chain>
Market Cap at query: $<mcap>

--- CONCENTRATION ---
Top 10 holders:  XX.X% of supply
Top 25 holders:  XX.X% of supply
Top 50 holders:  XX.X% of supply
Risk: [LOW | MEDIUM | HIGH | EXTREME]

--- WALLET QUALITY (top 100) ---
Smart Money / Fund:  N wallets
Fresh / unlabeled:   N wallets (XX%)
CEX wallets:         N wallets

--- CLUSTER ANALYSIS (top 20, depth 2) ---
Shared hubs found:   N addresses
Connected holders:   N of top 20 share ≥1 hub
Largest cluster:     N holders

--- CEX SAME-DAY FUNDING (top 20) ---
Coordinated groups:  N groups
Largest group:       N wallets funded from <CEX> on <date>
Single-entity funder: [YES | NO]

--- VERDICT ---
[CLEAN | MODERATE RISK | HIGH RISK | LIKELY COORDINATED]
```

---

## Cost Summary

| Mode | Phases | Approx calls |
|---|---|---|
| Fast (snapshot only) | 1 | 2-3 |
| Standard | 1 + 2 | ~23 |
| Full due diligence | 1 + 2 + 3 | ~43 |

Always tell the user the mode and estimated call count before running phases 2 or 3.
Default to Fast mode unless the user explicitly asks for deeper analysis.

---

## Notes

- `token holders` does not support native/wrapped tokens. Use the specific contract address.
- `profiler batch` limit: check `--help` for max addresses per call; split into batches of 50 if needed.
- Depth 2 hard cap is intentional. Depth 3 on 20 wallets = ~2,000+ nodes, prohibitively expensive.
- CEX label matching: look for labels containing "Binance", "Coinbase", "OKX", "Kraken", "Bybit", "HTX", "KuCoin" in `address_label` or `labels[]`.
- On Solana, `profiler related-wallets` may return fewer results than on Ethereum. Expand `--days` to 90 if empty.
