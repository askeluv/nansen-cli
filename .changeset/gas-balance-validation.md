---
"nansen-cli": patch
---

Add post-quote gas balance validation: rejects trades when the wallet lacks gas fees, unless the trade qualifies for gasless execution ($10+ USD value).
