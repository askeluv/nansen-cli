---
"nansen-cli": minor
---

Guard `wallet export` against accidental plaintext key disclosure. The default output is now redacted (addresses only — no decryption, no password needed). Printing private keys to stdout requires explicit acknowledgement via `--reveal` (which also warns on stderr when stdout is an interactive terminal), and the new `--file <path>` writes keys to a file created with 0600 permissions (refusing to overwrite) while keeping stdout clean. Scripts that parsed `wallet export` output must add `--reveal` or switch to `--file`.
