---
"nansen-cli": minor
---

Add trader_type, sectors_filter, sm_label_filter, and trader_label_filter filters to `nansen research perp screener` (ECINT-6680).

New CLI options:
- `--trader-type <type>` — filter by trader type: all, sm, whale, public_figure, high_winrate_hl_perps_trader
- `--sectors-filter <sectors>` — comma-separated sector:subcategory pairs, e.g. "Crypto:AI,TradFi:Stocks"
- `--sm-label-filter <labels>` — comma-separated Nansen SM labels (applies when trader-type is all or sm)
- `--trader-label-filter <labels>` — comma-separated HL perps trader labels (applies when trader-type is all or sm)
