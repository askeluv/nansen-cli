---
"nansen-cli": patch
---

Bind limit-order deposits to the trusted vault destination: reject any deposit whose wallet-sourced transfer (SPL token or native SOL) does not land in a token account this same transaction creates via CreateAccountWithSeed seeded off the user's vault. Covers both the SPL-token and native-SOL deposit paths.
