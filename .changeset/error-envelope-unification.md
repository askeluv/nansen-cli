---
"nansen-cli": minor
---

**Output shape change:** every command failure now serializes through the same error envelope — `{success: false, error, code, status, details}`. Previously a `CommandError` printed its structured payload at the top level instead, so errors from `trade`, `limit-order` and the API-key flows (`NOT_A_TTY`, `API_KEY_REQUIRED`, `INVALID_API_KEY`, `VERIFICATION_FAILED`) came back in a different shape from everything else.

Nothing is lost — the previous top-level payload is preserved verbatim under `details` — but anything parsing those errors positionally needs to read `details` instead of the root object. The new `perp` and `bridge` commands raise `CommandError` throughout, so without this they would have been the third distinct error shape in the CLI.

One deliberate exception: a missing-argument usage banner (`MISSING_PARAM`, `MISSING_ARGS`) prints as plain text when stdout is an interactive terminal and no output format was requested, because those messages are multi-line help written to be read and serializing them renders every newline as a literal `\n`. Piped output, and any run with `--pretty`, `--table`, `--format csv` or `--stream`, still gets the envelope — so nothing consuming the CLI programmatically sees a different shape.
