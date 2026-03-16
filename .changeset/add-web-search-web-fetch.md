---
"nansen-cli": minor
---

feat: add `nansen web search` and `nansen web fetch` commands (ECINT-6393)

- `nansen web search <query> [query...]` — search the web for one or more queries in parallel via `/api/v1/search/web-search`
- `nansen web fetch <url> [url...] --question <q>` — fetch and analyze URL content with AI via `/api/v1/search/web-fetch`
