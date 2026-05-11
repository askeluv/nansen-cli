---
name: nansen-token-screener
description: "Discover trending tokens — screener, SM holdings, Nansen indicators, and flow intelligence for promising finds. Use when scanning for new tokens or screening what's hot."
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

# Token Discovery

**Answers:** "What tokens are trending and worth a deeper look?"

```bash
CHAIN=solana

# Screen top tokens by volume
nansen research token screener --chain $CHAIN --timeframe 24h --limit 20
# → token_symbol, price_usd, price_change, volume, buy_volume, market_cap_usd, fdv, liquidity, token_age_days

# Smart money only
nansen research token screener --chain $CHAIN --timeframe 24h --smart-money --limit 20

# Search within screener results (client-side filter)
nansen research token screener --chain $CHAIN --search "bonk"

# Smart money holdings — what SM wallets are holding
nansen research smart-money holdings --chain $CHAIN --labels "Smart Trader" --limit 20
# → token_symbol, value_usd, holders_count, balance_24h_percent_change, share_of_holdings_percent

# Nansen indicators for a specific token
TOKEN=<address>
nansen research token indicators --token $TOKEN --chain $CHAIN
# → risk_indicators, reward_indicators (each with score, signal, signal_percentile)

# Flow intelligence — only use for promising tokens from screener/indicators above
nansen research token flow-intelligence --token $TOKEN --chain $CHAIN
# → net_flow_usd per label: smart_trader, whale, exchange, fresh_wallets, public_figure

# Nansen Score Top Tokens — "what should I buy?" (public endpoint, any authenticated API key)
# Use this FIRST for discovery, then drill into individual tokens with `indicators` above
nansen research token top-tokens --limit 25
nansen research token top-tokens --market-cap largecap --limit 10
# → chain, token_address, token_symbol, performance_score, risk_score,
#   per-indicator contributions, market_cap_group, latest_date, last_trigger_on
```

Screener timeframes: `5m`, `10m`, `1h`, `6h`, `24h`, `7d`, `30d`

Indicators: score is "bullish"/"bearish"/"neutral". signal_percentile > 70 = historically significant. Some tokens return empty indicators — not an error.

## Top tokens — Nansen Score field reference

Results are pre-filtered to `performance_score >= 15` server-side and returned sorted by:
1. `performance_score` DESC
2. `market_cap_group` priority (largecap → midcap → lowcap)
3. `risk_score` DESC
4. 24h volume DESC

So row 0 is always the strongest candidate for the filter you applied — no client-side ranking needed.

Market cap buckets (used in both the sort priority and the `--market-cap` filter):
- `lowcap`: market cap < $100M
- `midcap`: market cap $100M – $1B
- `largecap`: market cap > $1B

Every contribution is **ternary** — exactly one of `{negative, 0, positive}` per field. No partial values. Zero means "indicator didn't apply to this token" (out of scope), not "indicator was neutral".

**Performance Score (Alpha — "likely to outperform BTC over 7–30d")**
Range: `-60 to +75` (arithmetic bounds; live max is closer to `+45` since no single token hits every positive indicator simultaneously). Buy threshold: `>= 15`. Sum of the five `*_performance` fields below.
| Field | Contribution | Trigger | What the underlying indicator measures |
|---|---|---|---|
| `price_momentum_performance` | +30 / 0 | upstream score `bullish` → +30 | Price momentum, scored against separate thresholds for large-cap vs. low/mid-cap tokens. |
| `chain_fees_performance` | +30 / 0 | `bullish` (30-day fee growth > +1%) → +30 | 30-day spending momentum on network fees (geometric mean of daily returns). **Only tracked for a handful of L1 native tokens (e.g. ETH, TRX, AVAX, RON); always 0 for every other token.** |
| `trading_range_performance` | +15 / 0 | `bullish` (price breaks above resistance in an uptrend) → +15 | 14-day price trend combined with position vs. nearest support/resistance. In practice fires mostly on established tokens that have well-defined levels — can fire at any market cap, but is rare for new / low-liquidity tokens. |
| `chain_tvl_performance` | 0 / -35 | `bearish` (composite TVL growth < 0) → -35 | TVL momentum composite signal. Only non-zero for chains / L2s whose TVL is tracked. No positive path exists — the field only deducts. |
| `protocol_fees_performance` | 0 / -25 | `bearish` (14-day fee growth < -3%) → -25 | 14-day protocol fee momentum. Only non-zero for tokens backed by protocols with measurable fee revenue. No positive path — deduction only. |

**Risk Score (Safety — "filters falling knives / dangerous setups")**
Range: `-60 to +80` (arithmetic bounds). Safety threshold: `> 0` (positive = safer, negative = riskier). Sum of the four `*_risk` fields below. For every risk field: upstream score `low` → positive contribution, `high` → negative contribution, `medium`/missing → 0.
| Field | Contribution | What the underlying indicator measures |
|---|---|---|
| `btc_reflexivity_risk` | +40 / -20 | Rolling 5-event median ratio of token drop to BTC drop on days BTC falls >3%. Ratio ≤ 1 → `low` → **+40** (token holds up as well as or better than BTC on drawdowns). Ratio > 1 → `high` → **-20** (token drops harder than BTC). Skipped for stablecoins and tokens with <$1M 24h volume. |
| `liquidity_risk` | +20 / -20 | Ratio of on-chain liquidity to market cap (`total_liquidity_usd / market_cap_usd`). Higher ratio → `low` → **+20** (deep books relative to cap). Very thin ratio → `high` → **-20**. |
| `concentration_risk` | +10 / -10 | Top-10 holder concentration as a fraction of supply. `< 0.12` → `low` → **+10** (well-distributed). `> 0.55` → `high` → **-10** (whale-concentrated). |
| `inflation_risk` | +10 / -10 | EMA of daily token supply inflation rate. Negative / near-zero → `low` → **+10** (stable or deflationary supply). Strongly positive → `high` → **-10** (high dilution). Only evaluated for tokens >= $100M market cap. |

Other response fields:
- `market_cap_group`: `lowcap` / `midcap` / `largecap` — see thresholds above.
- `latest_date`: ISO datetime of the most recent indicator refresh for this token.
- `last_trigger_on`: ISO datetime of the most recent trigger across contributing indicators (MAX aggregate — individual indicators may be days-to-months stale even when this looks fresh). Use `indicators` on a specific token to audit per-indicator ages.

**Stablecoins rank high but aren't picks.** USDC, USDT, DAI, FDUSD and similar score well on chain_fees + liquidity indicators but aren't what "what should I buy" means. Filter them out of the shortlist using the canonical whitelist at `nansen-dbt-ch-tokens/seeds/stablecoins_for_indicator.csv` before drilling into `indicators`.

Typical workflow: start with `top-tokens` for a shortlist → drop stablecoins → run `indicators` on the top 3–5 to inspect individual signals and their signal_percentile → `flow-intelligence` only on the finalists to confirm SM conviction.

Field meanings and contribution mappings above are sourced from `nansen-dbt-ch-tokens/models/indicators/api_nansen_score_indicators_all_tokens_latest.sql` and per-indicator model yml files. Sign conventions and live value ranges were validated against production ClickHouse data.

Flow intelligence is credit-heavy. Use it to confirm SM conviction on tokens that already look promising from screener + indicators, not as a first pass on every token.
