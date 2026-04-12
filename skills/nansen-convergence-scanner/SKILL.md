---
name: nansen-convergence-scanner
description: "Detect when multiple independent smart money entities accumulate the same token. The highest-alpha signal: unrelated actors independently reaching the same conclusion."
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---

# Convergence Scanner

**Answers:** "Are multiple independent smart money actors converging on the same token?"

Chain: `0x` → `--chain ethereum` (also base, arbitrum, optimism, polygon). Base58 → `--chain solana`.

## Workflow

```bash
CHAIN=solana  # or ethereum, base

# ── Phase 1: Collect SM activity ────────────────────────────
# 1. Smart money netflow — who's accumulating?
nansen research smart-money netflow --chain $CHAIN --limit 20 --fields token_symbol,token_address,net_flow_usd
# 2. SM DEX trades — who's buying on-chain right now?
nansen research smart-money dex-trades --chain $CHAIN --limit 30 --fields token_symbol,token_address,maker,taker,value_usd

# ── Phase 2: Group by token ────────────────────────────────
# From results, find tokens with 2+ DISTINCT wallet addresses.
# These are convergence candidates.

# ── Phase 3: Verify independence ────────────────────────────
# For each candidate token with addresses ADDR_A and ADDR_B:
ADDR_A=<first_address>
ADDR_B=<second_address>

# 3a. Check if they're related (same entity = NOT convergence)
nansen research profiler related-wallets --address $ADDR_A --chain $CHAIN
# If ADDR_B appears in ADDR_A's related wallets → same entity, skip.

# 3b. Compare directly — shared counterparties + tokens
nansen research profiler compare --addresses "$ADDR_A,$ADDR_B" --chain $CHAIN
# If shared_counterparties >= 3 → likely same entity, skip.

# 3c. Label both — different entity types strengthens signal
nansen research profiler labels --address $ADDR_A --chain $CHAIN
nansen research profiler labels --address $ADDR_B --chain $CHAIN

# ── Phase 4: Enrich convergence signal ──────────────────────
TOKEN=<token_address>
# 4a. Token fundamentals
nansen research token info --token $TOKEN --chain $CHAIN
# 4b. Flow breakdown by label (Fund, Smart Trader, Whale, etc.)
nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
```

## Independence test

Two addresses are **independent** when ALL of these hold:
- Address B is NOT in address A's `related-wallets`
- `profiler compare` shows < 3 shared counterparties
- They have different labels (Fund vs Smart Trader strengthens signal)

If any test fails → same entity, not convergence.

## Signal strength

| Independent entities | Strength | Action |
|---------------------|----------|--------|
| 2 | Moderate | Flag for review |
| 3+ | Strong | High-priority alert |
| 3+ with different label types | Very strong | Highest conviction signal |

## Output format

For each convergence signal, report:

- **Token**: symbol, address, chain
- **Entity count**: number of independent actors
- **Actors**: address, label, direction (buy/sell), value
- **Independence proof**: no related-wallets link, < 3 shared counterparties
- **Flow context**: token flow-intelligence breakdown (which label categories are buying)

## Credit cost

Per convergence scan: ~6-12 CLI calls.
- Phase 1: 2 calls (netflow + dex-trades)
- Phase 3: 3-4 calls per candidate pair (related-wallets + compare + labels)
- Phase 4: 2 calls per confirmed signal (info + flow-intelligence)

Keep `--limit` low to control costs. Most scans find 0-3 convergence candidates.

## Source

- npm: https://www.npmjs.com/package/nansen-cli
- GitHub: https://github.com/nansen-ai/nansen-cli
