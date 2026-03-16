# Holder Concentration — Reference

## Why top 100 + all-holder first-funder check

Coordinated cartels frequently position outside the top 20. A group controlling positions 30-70 is invisible if first-funder analysis stops at top 20. Running `related-wallets` on all 100 is cheap (lightweight endpoint, no BFS fan-out) and catches hidden controllers.

## Concentration thresholds

| Top 10 ownership | Risk level |
|---|---|
| <30% | Low |
| 30-50% | Medium |
| 50-70% | High |
| >70% | Extreme |

These are heuristics, not hard rules. Context matters: a VC-backed launch may show high concentration legitimately.

## CEX same-day funding logic

Group top-100 holders by `(funder_label, date(block_timestamp))`. Flag groups of ≥2.

Also check consecutive-day windows. Pseudocode:

```
for each cex_funder in funders:
    dates = sorted(unique funding dates for cex_funder)
    runs = []
    current_run = [dates[0]]
    for d in dates[1:]:
        if d - current_run[-1] <= 1 day:
            current_run.append(d)
        else:
            runs.append(current_run)
            current_run = [d]
    runs.append(current_run)
    for run in runs:
        wallets_in_run = wallets funded by cex_funder on any date in run
        if len(run) <= 3 days AND len(wallets_in_run) >= 3:
            flag HIGH coordination signal
```

This catches actors who split CEX withdrawals across 2-3 consecutive calendar days to avoid same-day detection. A run spanning ≤3 days with ≥3 total wallets = HIGH coordination signal.

Known CEX label substrings to match: `Binance`, `Coinbase`, `OKX`, `Kraken`, `Bybit`, `HTX`, `KuCoin`, `Gate.io`, `MEXC`.

Note: funder_label comes from the `related-wallets` response. If empty, check `address_label` on the funder address via `profiler labels`.

## Single-controller detection

Group by raw `funder_address` (non-CEX). If one address funds ≥3 top-100 holders, it controls multiple positions. Cross-reference the funder address with `profiler labels` to identify it.

## BFS clustering (Phase 3)

Shared hub detection:
1. Collect all `nodes[]` from each trace into a map: `{address → Set<trace_seed>}`.
2. Any address appearing in ≥3 seed sets is a shared hub.
3. Two holders are "connected" if their traces share ≥1 hub.
4. Cluster size = number of top-20 holders in the largest connected component.

Deduplication: skip `profiler trace` on a seed if it was already visited as a node in a prior trace.

## `profiler batch` behaviour

Despite the name, `profiler batch` is sequential: one API call per address with a configurable delay (default 1000ms). For 100 addresses, budget ~100 API credits and ~100 seconds wall time. Hard limit: 100 addresses per invocation.

`--include pnl` is available: adds PnL per holder, useful for detecting underwater positions (potential sellers).

If all wallets are already labeled after Phase 1 step 1, skip `profiler batch` entirely — it would return no new information and waste API calls.

## Verdict rubric

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

**Verdict** = highest matching row: CLEAN (no flags) → MODERATE → HIGH → EXTREME.

---

## Failure Modes and Edge Cases

### Empty holders list
Token too new or unindexed. Treat as no data, not a clean signal. Skip analysis entirely.

### ownership_percentage = 0.00%
Large-supply token precision issue (e.g. USDC). Fallback: compute `token_amount / sum(token_amounts) * 100` from raw balances.

### Fewer than 100 holders returned
Adjust all top-N thresholds proportionally. If `actual_count < 20`, flag as too sparse for reliable analysis and note this in the verdict.

### Batch with 0 unlabeled addresses
Skip `profiler batch` call entirely. Not an error but wastes API calls if executed.

### related-wallets returns no First Funder
Wallet may be funded via `Multisig Signer` or `Deployed by` relation. Log the relation types returned and check manually. Do not assume no funder = self-funded.

### 429 rate limiting
Add `--delay 500` to `related-wallets` loop. Default 300ms may be too fast for 100 consecutive calls. Back off exponentially on repeated 429s.

### Wrapped/native token error
`token holders` does not support SOL/WSOL/native assets. Must use the SPL token contract address. Check for known native wrapper addresses and reject early.

### Trace fan-out
Default `--width 10` with `--depth 2` = up to 111 nodes per seed. Use `--width 3` for initial scan, increase only if cluster signal is weak. Monitor `stats.nodes_visited` and abort if >50 nodes.

---

## Additional Signal Sources (Optional)

### token info (1 call)
Returns `creation_date`, `deployer`. Use to compute token age. Age <7d = escalate all risk thresholds (e.g. top 10 >30% becomes EXTREME).

### token indicators (1 call)
Returns Nansen Score + concentration/team_control signals. If available, use as Phase 1 shortcut — extreme concentration or `team_control=high` may skip manual concentration calc.

### profiler batch --include pnl
Adds PnL per holder. Detect underwater positions — holders deep in loss are potential sellers, not long-term holders. Useful for distinguishing trapped retail from committed whales.

### token flow-intelligence (1 call)
`fresh_wallet` outflow during accumulation = distribution signal. If fresh wallets are receiving tokens while smart money is selling, the token may be in a distribution phase.

### token who-bought-sold (1 call)
Recent buyer quality check. Complements the static holder snapshot with dynamic trade data. Look for SM sellers paired with fresh wallet buyers as a red flag.
