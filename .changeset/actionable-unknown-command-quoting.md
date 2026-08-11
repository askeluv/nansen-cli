---
"nansen-cli": patch
---

Unknown-command errors now detect when a whole multi-word command was passed as a single argument (a common shell-quoting mistake, e.g. `nansen "trade --help"` or an unquoted variable under zsh) and point at the likely cause instead of a bare "Unknown command".
