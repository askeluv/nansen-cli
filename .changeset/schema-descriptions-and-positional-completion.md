---
"nansen-cli": minor
---

Every command option in `nansen schema` now carries a type and a description (140 research and `wallet send` options had neither), and the `research points` group is described. `research token ohlcv --timeframe` documents its real default (`1d`), and `wallet send --chain`, `research search --type`, and the prediction-market `--neg-risk` filters declare the values they accept, so `--help` and shell completion offer them. Fixed `--neg-risk true` on the prediction-market screeners, which was sent to the API as `neg_risk: false` because the parsed boolean was compared against the string `'true'`. `nansen mcp install` and `nansen mcp uninstall` declare their positional client in the schema, and `nansen completion` scripts now complete it (`claude-code`, `claude-desktop`, `cursor`) in bash, zsh, and fish.
