---
"nansen-cli": minor
---

Add post-install onboarding that interactively offers to install the Nansen AI coding skill and run a test query after `npm install -g nansen-cli`. Non-interactive environments (CI, piped stdin) receive a one-liner tip and are never blocked.
