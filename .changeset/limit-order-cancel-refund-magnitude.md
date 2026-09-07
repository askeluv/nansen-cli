---
"nansen-cli": patch
---

Close two dust-refund gaps in limit-order cancel verification: a native-SOL refund at or below the fee/rent slack could be "cancelled" by returning a single lamport while the rest of the escrow was rerouted, and a cancel now fails closed when the order is found but its remaining refund amount can't be computed instead of silently downgrading to a bare positive-inflow check.
