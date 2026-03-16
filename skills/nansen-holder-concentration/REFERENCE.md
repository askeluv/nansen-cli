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

Also check ±1 day windows: wallets funded from the same CEX across 2-3 consecutive days may indicate the same coordinated actor splitting entries to avoid detection. Flag any CEX funder appearing across ≤3 consecutive calendar days with ≥3 total wallets.

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

## Verdict rubric

| Signal combination | Verdict |
|---|---|
| Low concentration + SM holders + no CEX clustering | CLEAN |
| Medium concentration + mixed labels | MODERATE RISK |
| High concentration + fresh wallets + no SM | HIGH RISK |
| Extreme concentration + CEX same-day clusters + shared hubs | LIKELY COORDINATED |
