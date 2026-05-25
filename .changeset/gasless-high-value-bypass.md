---
"nansen-cli": patch
---

Skip native gas pre-check for trades >= $10 USD, where gasless/solver-paid routes (e.g. Relay) are viable. When gas is insufficient on smaller trades, the error now also suggests increasing the trade value as an alternative to topping up gas.
