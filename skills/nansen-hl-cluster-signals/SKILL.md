---
name: nansen-hl-cluster-signals
description: Read Hyperliquid cluster ENTRY signal feed events (internal) with lookback and source filters. Use for execution agents that consume HL cluster signals.
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

# HL Cluster Signals

Read the internal append-only HL cluster signal event feed.

## Command

```bash
nansen research signals hl-cluster [options]
```

## Defaults

- Last `7d` lookback
- `limit=200`
- Latest-first ordering

## Options

- `--last <Nd>` lookback window, e.g. `7d` (default)
- `--from <iso>` explicit start time (overrides `--last`)
- `--to <iso>` explicit end time (overrides `--last`)
- `--coin <symbol>` filter by coin
- `--week-id <YYYY-W##>` filter by week
- `--source <weekly|live>` filter by source
- `--limit <n>` page size
- `--page <n>` page number

## Examples

```bash
nansen research signals hl-cluster --last 7d --limit 200
nansen research signals hl-cluster --coin xyz:CL --source live --last 2d
nansen research signals hl-cluster --week-id 2026-W14 --source weekly --limit 100
nansen research signals hl-cluster --from 2026-04-01T00:00:00Z --to 2026-04-02T00:00:00Z
```
