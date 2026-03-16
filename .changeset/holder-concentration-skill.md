---
"nansen-cli": minor
---

Add nansen-holder-concentration skill: complete agent-optimized rewrite.

Phase 1: top-100 holder concentration with token age check and label batch.
Phase 2: first-funder clustering across all unlabeled holders (auto-triggered if unlabeled >40%).
Phase 3: BFS connection graph on top 20 (expert, opt-in).

Includes: ownership % precision fallback, holder count validation, consolidated risk table,
full failure mode documentation, and additional signal source references (token info,
token indicators, flow-intelligence, who-bought-sold).
