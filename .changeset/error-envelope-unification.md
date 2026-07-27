---
"nansen-cli": minor
---

**Output shape change:** every command failure now serializes through the same error envelope — `{success: false, error, code, status, details}`. Previously a `CommandError` printed its structured payload at the top level instead, so errors from `trade`, `limit-order` and the API-key flows (`NOT_A_TTY`, `API_KEY_REQUIRED`, `INVALID_API_KEY`, `VERIFICATION_FAILED`) came back in a different shape from everything else.

Nothing is lost — the previous top-level payload is preserved verbatim under `details` — but anything parsing those errors positionally needs to read `details` instead of the root object. The new `perp` and `bridge` commands raise `CommandError` throughout, so without this they would have been the third distinct error shape in the CLI.
