---
"nansen-cli": patch
---

Add a client-side Hyperliquid action builder (`src/hl-action.js`), the groundwork for submitting perp trades straight to Hyperliquid instead of round-tripping through the Nansen backend to build them.

- msgpack encoder that reproduces the reference `msgpack.packb` output byte-for-byte (insertion-ordered maps, smallest-width ints, utf-8 strings), so an action's `connectionId` hash matches the known-good path.
- `actionHash` + `l1Eip712` reproduce the phantom-agent EIP-712 payload (Exchange domain, mainnet `source: "a"`) that the existing signer already knows how to sign.
- Order-wire assembly for market/limit orders, cancels, closes and leverage updates, including TP/SL (`normalTpsl`) grouping and the builder-code attachment.
- Price/size rounding (`roundPrice`/`roundSize`) ported with Python-parity banker's rounding, so over-precise values that Hyperliquid would reject are rounded identically to the server path.
- `approveBuilderFee` and `usdClassTransfer` user-signed payload builders.

Pinned against the live prepare endpoints with golden-vector tests that assert both the built action and its `connectionId` match byte-for-byte.
