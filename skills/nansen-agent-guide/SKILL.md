---
name: nansen-agent-guide
description: Routing guide -- when to use `nansen agent` (AI research) vs direct CLI data commands. Use when deciding how to answer a user's research question with Nansen tools.
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

# Agent vs CLI Routing

| Need a... | Use |
|-----------|-----|
| **take** (analysis, interpretation) | `nansen agent` |
| **table** (raw data, specific metrics) | Direct CLI commands |
| **report** (both) | Agent for narrative + CLI for data |

## Use `nansen agent` when

- Question requires interpretation or synthesis across multiple data sources
- Open-ended research: "analyse this wallet", "what's happening with ETH smart money?"

```bash
nansen agent "What are top smart money tokens on Solana today and why?"
nansen agent "Analyse wallet 0x123... -- is this a smart trader?"
nansen agent "..." --expert   # deeper analysis, 750 credits
```

Cost: 200 credits (fast) / 750 credits (expert)

## Use direct CLI commands when

- You need specific structured data -- prices, volumes, holders, flows
- Deterministic question: "top 10 tokens by netflow on ethereum"
- Piping output or building a data table

```bash
nansen research token screener --chain ethereum --smart-money --limit 10
nansen research smart-money netflow --chain solana
nansen research profiler balance --address 0x123... --chain ethereum
```

Cost: 5-50 credits per call

## Anti-patterns

- Don't use `nansen agent` for simple data fetches -- 40x more expensive
- Don't use raw CLI for open-ended analysis -- returns data, not interpretation
- Don't chain 3+ agent calls -- get raw data via CLI, call agent once for synthesis
