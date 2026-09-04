# Convergence Scanner — Reference

## Why convergence matters

Individual wallet tracking shows one actor's opinion. Convergence detects when **multiple unrelated actors independently reach the same conclusion** — a qualitatively stronger signal than any single whale trade.

A Fund, a Smart Trader, and an independent whale all accumulating the same token within the same window is not coordination — it's market wisdom emerging from independent analysis.

## Independence Protocol

Run Phase 3 for every pair of addresses on the same token. Skip the token if ANY pair fails independence:

1. `profiler related-wallets` on address A — if B appears, **same entity**
2. `profiler compare` on A,B — if `shared_counterparties >= 3`, **likely same entity**
3. `profiler labels` on both — if identical labels AND same first funder, **same entity**

**Independent = passes all three tests.**

## Label diversity scoring

Convergence is stronger when entities have different label types:

| Mix | Multiplier | Rationale |
|-----|-----------|-----------|
| Fund + Smart Trader | 1.5x | Different strategies, same conclusion |
| Fund + Whale | 1.3x | Informed + size |
| Smart Trader + Fresh Wallet | 1.0x | Fresh could be noise |
| Same label on both | 0.8x | Possible coordination despite independence tests |

## Multi-chain convergence

When the same token trades on multiple chains (e.g., ETH on ethereum + arbitrum + base), extend the scan:

```bash
for CHAIN in ethereum base arbitrum; do
  nansen research smart-money netflow --chain $CHAIN --limit 20 --fields token_symbol,token_address,net_flow_usd
done
```

Cross-chain convergence (SM buying on ethereum AND base) is an even stronger signal than same-chain convergence.

## False positives to filter

- **Stablecoins** — USDC/USDT/DAI will always show multiple SM addresses. Exclude them.
- **Wrapped natives** — WETH/WSOL are operational, not directional. Exclude them.
- **Airdrop farming** — Multiple addresses buying a new token on launch day. Check if addresses were created recently (`profiler labels` → "Fresh Wallet"). If all are fresh → likely farm, not convergence.
- **Market maker flows** — Addresses labeled "Market Maker" are providing liquidity, not taking directional bets. Exclude them from convergence counting.

## Conviction boost

When convergence is confirmed, the implied conviction of related signals should increase:
- **Moderate** (2 entities): +10 to any prior conviction score on this token
- **Strong** (3+ entities): +15, capped at 95
- **Very strong** (3+ with label diversity): +20, capped at 95

## Cost warnings

- Each candidate pair costs 3-4 API calls for independence verification
- A token with 5 SM addresses = 10 pairs = up to 40 calls — cap at 3 pairs per token
- Use `--fields` on Phase 1 calls to reduce response size
- `profiler compare` may return sparse data for wallets with few on-chain interactions
