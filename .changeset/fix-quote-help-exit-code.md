---
"nansen-cli": patch
---

Fix `nansen quote --help`, `nansen trade quote --help`, and `nansen execute --help` to print the trade usage and exit with code 0 instead of erroring with exit code 1.
