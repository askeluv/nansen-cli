---
name: nansen-web-search
description: Search the web for one or more queries in parallel. Use when you need current information, news, prices, or any web content to complement on-chain Nansen data.
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

# Web Search

Search the web for one or more queries in parallel via the Serper API.

```bash
nansen web search "bitcoin price"
nansen web search "solana ecosystem news" --num-results 5
nansen web search --query "ethereum ETF" --query "bitcoin ETF" --num-results 3
```

Positional args and `--query` flags can be combined — all become queries.

| Flag | Values | Default | Purpose |
|------|--------|---------|---------|
| `--query` | string | — | Query string (repeatable for multiple queries) |
| `--num-results` | 1–20 | 10 | Results per query |
| `--pretty` | flag | off | Human-readable JSON |

Returns `results[]` — one entry per query, each with `organic[]` (title, link, snippet, date) and optional `knowledge_graph`.

**Note:** Some domains are excluded from results (paywalled/unfetchable sites like bloomberg.com, twitter.com). Use `nansen web fetch` to retrieve content from specific URLs.
