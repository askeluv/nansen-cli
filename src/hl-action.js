/**
 * Nansen CLI — Hyperliquid action builder (client-side, direct-to-HL).
 *
 * Ports the deterministic signing path of the hyperliquid-python-sdk
 * (`utils/signing.py`) and nansen-api's `hyperliquid_exchange.py::prepare_*`
 * into JS, so the CLI can build the exact L1 action + EIP-712 payload locally
 * and submit straight to api.hyperliquid.xyz — no server round-trip to build it.
 *
 * The one primitive the CLI lacked is a msgpack encoder: an L1 action's hash is
 *   keccak256( msgpack(action) ‖ nonce(8B BE) ‖ vault-byte )
 * which becomes the EIP-712 `connectionId`. Everything else (keccak, secp256k1,
 * EIP-712 hashing) already exists in crypto.js / x402-evm.js.
 *
 * Correctness is pinned byte-for-byte against the live API `/perp/*` prepare
 * endpoints via golden-vector tests — the msgpack + rounding + wire assembly
 * either reproduces the known-good Python output exactly or the test fails.
 *
 * Note: the L1 actions hashed here carry NO floats — prices and sizes are
 * stringified by floatToWire before msgpack, so the encoder only handles
 * str/int/bool/map/array. Float64 support is included for completeness only.
 */

import { keccak256 } from './crypto.js';
import { hlNetwork } from './hl-env.js';
import { CommandError } from './api.js';

// Phantom-agent `source` for an L1 action: "a" on mainnet, "b" on testnet
// (signing.py). Every builder below takes the network as an argument defaulting
// to hlNetwork(), so a caller can pin it in a test while the CLI stays in step
// with whatever base URL it will actually submit to.
function phantomAgentSource(network) {
  return network === 'Testnet' ? 'b' : 'a';
}

// ── msgpack encoder ──────────────────────────────────────────────────
//
// Matches Python `msgpack.packb(action)` byte-for-byte for the value types we
// emit: map (JS object, insertion order preserved), array, str (utf-8), bool,
// and int. Widths are chosen smallest-first, unsigned preferred for
// non-negative ints — exactly what the reference implementation does.

function encodeInt(nRaw) {
  const n = BigInt(nRaw);
  if (n >= 0n) {
    if (n <= 0x7fn) return Buffer.from([Number(n)]); // positive fixint
    if (n <= 0xffn) return Buffer.from([0xcc, Number(n)]); // uint8
    if (n <= 0xffffn) {
      const b = Buffer.alloc(3);
      b[0] = 0xcd;
      b.writeUInt16BE(Number(n), 1);
      return b;
    }
    if (n <= 0xffffffffn) {
      const b = Buffer.alloc(5);
      b[0] = 0xce;
      b.writeUInt32BE(Number(n), 1);
      return b;
    }
    const b = Buffer.alloc(9);
    b[0] = 0xcf;
    b.writeBigUInt64BE(n, 1);
    return b;
  }
  if (n >= -0x20n) {
    // negative fixint (0xe0..0xff) — single two's-complement byte
    const b = Buffer.alloc(1);
    b.writeInt8(Number(n), 0);
    return b;
  }
  if (n >= -0x80n) return Buffer.from([0xd0, Number(n) & 0xff]); // int8
  if (n >= -0x8000n) {
    const b = Buffer.alloc(3);
    b[0] = 0xd1;
    b.writeInt16BE(Number(n), 1);
    return b;
  }
  if (n >= -0x80000000n) {
    const b = Buffer.alloc(5);
    b[0] = 0xd2;
    b.writeInt32BE(Number(n), 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xd3;
  b.writeBigInt64BE(n, 1);
  return b;
}

function encodeFloat(x) {
  const b = Buffer.alloc(9);
  b[0] = 0xcb; // float64
  b.writeDoubleBE(x, 1);
  return b;
}

function encodeStr(s) {
  const utf8 = Buffer.from(s, 'utf8');
  const len = utf8.length;
  let head;
  if (len <= 31) head = Buffer.from([0xa0 | len]); // fixstr
  else if (len <= 0xff) head = Buffer.from([0xd9, len]); // str8
  else if (len <= 0xffff) {
    head = Buffer.alloc(3);
    head[0] = 0xda; // str16
    head.writeUInt16BE(len, 1);
  } else {
    head = Buffer.alloc(5);
    head[0] = 0xdb; // str32
    head.writeUInt32BE(len, 1);
  }
  return Buffer.concat([head, utf8]);
}

function encodeArray(arr) {
  const len = arr.length;
  let head;
  if (len <= 15) head = Buffer.from([0x90 | len]); // fixarray
  else if (len <= 0xffff) {
    head = Buffer.alloc(3);
    head[0] = 0xdc; // array16
    head.writeUInt16BE(len, 1);
  } else {
    head = Buffer.alloc(5);
    head[0] = 0xdd; // array32
    head.writeUInt32BE(len, 1);
  }
  return Buffer.concat([head, ...arr.map(encodeMsgpack)]);
}

function encodeMap(obj) {
  const keys = Object.keys(obj);
  const len = keys.length;
  let head;
  if (len <= 15) head = Buffer.from([0x80 | len]); // fixmap
  else if (len <= 0xffff) {
    head = Buffer.alloc(3);
    head[0] = 0xde; // map16
    head.writeUInt16BE(len, 1);
  } else {
    head = Buffer.alloc(5);
    head[0] = 0xdf; // map32
    head.writeUInt32BE(len, 1);
  }
  const parts = [head];
  for (const k of keys) {
    parts.push(encodeStr(k));
    parts.push(encodeMsgpack(obj[k]));
  }
  return Buffer.concat(parts);
}

// Encode a JS value as msgpack. Integers are detected via Number.isInteger
// (all numeric action fields we emit — asset id, fee, order id, leverage — are
// integers; prices/sizes are already strings), so a bare number never takes the
// float64 path unless it genuinely has a fractional part.
export function encodeMsgpack(v) {
  if (v === null || v === undefined) return Buffer.from([0xc0]); // nil
  if (typeof v === 'boolean') return Buffer.from([v ? 0xc3 : 0xc2]);
  if (typeof v === 'bigint') return encodeInt(v);
  if (typeof v === 'number') return Number.isInteger(v) ? encodeInt(v) : encodeFloat(v);
  if (typeof v === 'string') return encodeStr(v);
  if (Array.isArray(v)) return encodeArray(v);
  if (typeof v === 'object') return encodeMap(v);
  throw new Error(`msgpack: unsupported type ${typeof v}`);
}

// ── Number formatting (ports of signing.py) ──────────────────────────

// Port of `float_to_wire`: fixed 8-decimal render, verify it doesn't lose
// precision, then strip trailing zeros (Decimal.normalize + `:f`). Produces the
// canonical decimal string HL expects in order wires (e.g. 1924.7 -> "1924.7",
// 0.006 -> "0.006", 2000 -> "2000"). No scientific notation.
export function floatToWire(x) {
  const rounded = x.toFixed(8);
  if (Math.abs(parseFloat(rounded) - x) >= 1e-12) {
    throw new Error(`floatToWire causes rounding: ${x}`);
  }
  let s = rounded;
  if (s.indexOf('.') !== -1) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  // Normalize a signed zero ("-0") to "0", matching the SDK.
  if (s === '-0') s = '0';
  return s;
}

// Round a positive-ish value to the nearest integer, ties-to-even (banker's).
function roundHalfEven(y) {
  const floor = Math.floor(y);
  const diff = y - floor;
  if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(y);
}

// Port of Python's round(x, ndigits): round-half-to-even. For negative ndigits
// we scale by an integer factor and multiply back (never divide by 0.1, which
// injects float dirt that later trips floatToWire's precision guard).
export function pyRound(x, ndigits) {
  if (!Number.isFinite(x)) return x;
  if (ndigits >= 0) {
    const m = 10 ** ndigits;
    const y = x * m;
    const floor = Math.floor(y);
    const halfUnits = 2 * floor + 1;
    // toFixed observes which side of a decimal half the binary float is on.
    // Preserve ties-to-even only when that half is itself exactly representable.
    if (
      y - floor === 0.5
      && Number.isSafeInteger(halfUnits)
      && BigInt(halfUnits) % (5n ** BigInt(ndigits)) === 0n
    ) {
      return roundHalfEven(y) / m;
    }
    return parseFloat(x.toFixed(ndigits));
  }
  const m = 10 ** -ndigits; // integer
  return roundHalfEven(x / m) * m;
}

// 5-significant-figure round, ties-to-even — matches Python's f"{x:.5g}" (the
// first stage of HL's price rounding). toPrecision() rounds ties away from zero,
// so it can't be used here.
function roundSigFigs(x, sig) {
  if (x === 0) return 0;
  const digits = Math.floor(Math.log10(Math.abs(x))) + 1; // integer-part digits
  return pyRound(x, sig - digits);
}

// Port of `_round_size`: round size to the asset's szDecimals.
export function roundSize(size, szDecimals) {
  return pyRound(size, szDecimals);
}

// Port of `_round_price`: 5 significant figures, then round to (6 - szDecimals)
// decimal places (perps). f"{price:.5g}" == Number.toPrecision(5) reparsed.
export function roundPrice(price, szDecimals) {
  const px = roundSigFigs(price, 5);
  return pyRound(px, Math.max(0, 6 - szDecimals));
}

// ── Order wire assembly (ports of signing.py) ────────────────────────

function orderTypeToWire(orderType) {
  if ('limit' in orderType) return { limit: orderType.limit };
  if ('trigger' in orderType) {
    // Key order matches the SDK: isMarket, triggerPx, tpsl.
    return {
      trigger: {
        isMarket: orderType.trigger.isMarket,
        triggerPx: floatToWire(orderType.trigger.triggerPx),
        tpsl: orderType.trigger.tpsl,
      },
    };
  }
  throw new Error('Invalid order type');
}

// Port of `order_request_to_order_wire`. Key order (a,b,p,s,r,t) is load-bearing
// — it's the msgpack map insertion order the hash depends on. No cloid ("c"):
// the CLI never sets one.
function orderRequestToOrderWire(order, asset) {
  return {
    a: asset,
    b: order.isBuy,
    p: floatToWire(order.limitPx),
    s: floatToWire(order.sz),
    r: order.reduceOnly,
    t: orderTypeToWire(order.orderType),
  };
}

// Port of `order_wires_to_order_action`. builder ({b,f}) is appended last, only
// when present — matching the SDK, so a builderless action hashes identically.
function orderWiresToOrderAction(orderWires, builder, grouping = 'na') {
  const action = { type: 'order', orders: orderWires, grouping };
  if (builder) action.builder = builder;
  return action;
}

// Port of `_validate_tpsl`: a stop/take on the wrong side of entry would trigger
// immediately and self-close the position the moment it opens.
//
// Deliberately validated against the raw `--price`, not the slippage-adjusted IOC
// limit computed below, to match the reference implementation. A take-profit set
// just past the mark on a market order can therefore land inside the slippage
// band; that is accepted here rather than rejected.
function validateTpsl({ isBuy, price, takeProfit, stopLoss }) {
  if (isBuy) {
    if (stopLoss != null && stopLoss >= price) {
      throw new Error(`Stop-loss for a long must be below the entry price (${price}). Got: ${stopLoss}`);
    }
    if (takeProfit != null && takeProfit <= price) {
      throw new Error(`Take-profit for a long must be above the entry price (${price}). Got: ${takeProfit}`);
    }
  } else {
    if (stopLoss != null && stopLoss <= price) {
      throw new Error(`Stop-loss for a short must be above the entry price (${price}). Got: ${stopLoss}`);
    }
    if (takeProfit != null && takeProfit >= price) {
      throw new Error(`Take-profit for a short must be below the entry price (${price}). Got: ${takeProfit}`);
    }
  }
}

function assertPositiveOrderValues(size, price, szDecimals) {
  if (size <= 0) {
    throw new CommandError(`Order size rounds to zero at ${szDecimals} decimals.`, 'ZERO_SIZE');
  }
  if (price <= 0) {
    throw new CommandError('Order price rounds to zero.', 'ZERO_PRICE');
  }
}

// ── Action builders (ports of hyperliquid_exchange.py::prepare_*) ─────
//
// Each takes the asset metadata (assetId + szDecimals) the caller sourced from
// the proxy `GET /perp/meta` endpoint (Decision D4: reads stay on the proxy).
// `builder` is the {b: <addr lowercased>, f: <fee tenths-bp>} code, attached to
// order/close fills. Returns { action, size, price } where size/price are the
// rounded values actually encoded (so callers can report the real fill).

export function buildOrderAction(
  // coin is resolved to assetId/szDecimals by the caller (proxy /perp/meta), so
  // it isn't needed here — the asset metadata is passed in the second argument.
  { isBuy, size, price, orderType = 'limit', reduceOnly = false, tif = 'Gtc', slippage = 0.03, takeProfit = null, stopLoss = null, builder = null },
  { assetId, szDecimals },
) {
  validateTpsl({ isBuy, price, takeProfit, stopLoss });
  const roundedSize = roundSize(size, szDecimals);

  let effectivePrice;
  let ot;
  if (orderType === 'market') {
    const raw = isBuy ? price * (1 + slippage) : price * (1 - slippage);
    effectivePrice = roundPrice(raw, szDecimals);
    ot = { limit: { tif: 'Ioc' } };
  } else {
    effectivePrice = roundPrice(price, szDecimals);
    ot = { limit: { tif } };
  }
  assertPositiveOrderValues(roundedSize, effectivePrice, szDecimals);

  const wires = [
    orderRequestToOrderWire({ isBuy, sz: roundedSize, limitPx: effectivePrice, orderType: ot, reduceOnly }, assetId),
  ];

  let grouping = 'na';
  if (takeProfit != null || stopLoss != null) {
    grouping = 'normalTpsl';
    if (takeProfit != null) {
      const rtp = roundPrice(takeProfit, szDecimals);
      wires.push(
        orderRequestToOrderWire(
          { isBuy: !isBuy, sz: roundedSize, limitPx: rtp, orderType: { trigger: { triggerPx: rtp, isMarket: true, tpsl: 'tp' } }, reduceOnly: true },
          assetId,
        ),
      );
    }
    if (stopLoss != null) {
      const rsl = roundPrice(stopLoss, szDecimals);
      wires.push(
        orderRequestToOrderWire(
          { isBuy: !isBuy, sz: roundedSize, limitPx: rsl, orderType: { trigger: { triggerPx: rsl, isMarket: true, tpsl: 'sl' } }, reduceOnly: true },
          assetId,
        ),
      );
    }
  }

  const action = orderWiresToOrderAction(wires, builder, grouping);
  return { action, size: roundedSize, price: effectivePrice };
}

export function buildCancelAction({ orderId }, { assetId }) {
  return { action: { type: 'cancel', cancels: [{ a: assetId, o: orderId }] } };
}

export function buildCloseAction({ size, price, isBuy, slippage = 0.03, builder = null }, { assetId, szDecimals }) {
  const raw = isBuy ? price * (1 + slippage) : price * (1 - slippage);
  const effectivePrice = roundPrice(raw, szDecimals);
  const roundedSize = roundSize(size, szDecimals);
  assertPositiveOrderValues(roundedSize, effectivePrice, szDecimals);
  const wire = orderRequestToOrderWire(
    { isBuy, sz: roundedSize, limitPx: effectivePrice, orderType: { limit: { tif: 'Ioc' } }, reduceOnly: true },
    assetId,
  );
  const action = orderWiresToOrderAction([wire], builder);
  return { action, size: roundedSize, price: effectivePrice };
}

export function buildLeverageAction({ leverage, isCross = true }, { assetId }) {
  return { action: { type: 'updateLeverage', asset: assetId, isCross, leverage } };
}

// ── L1 hashing + phantom-agent EIP-712 (ports of signing.py) ─────────

// Port of `action_hash(action, vault_address, nonce, None)`. We never set
// expiresAfter, so the trailing expires-block is omitted (matches the API,
// which passes expires_after=None).
export function actionHash(action, vaultAddress, nonce) {
  const packed = encodeMsgpack(action);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce), 0);
  const parts = [packed, nonceBuf];
  if (vaultAddress == null) {
    parts.push(Buffer.from([0x00]));
  } else {
    parts.push(Buffer.from([0x01]));
    parts.push(Buffer.from(vaultAddress.replace(/^0x/, ''), 'hex'));
  }
  return keccak256(Buffer.concat(parts));
}

// Port of construct_phantom_agent + l1_payload (source "a"/"b" by network,
// chainId 1337, Exchange domain). Returns the EIP-712 payload the CLI's
// signAgent() already knows how to sign.
export function l1Eip712(action, vaultAddress, nonce, network = hlNetwork()) {
  const hash = actionHash(action, vaultAddress, nonce);
  const connectionId = '0x' + hash.toString('hex');
  return {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: phantomAgentSource(network), connectionId },
  };
}

// ── User-signed actions (approveBuilderFee / usdClassTransfer) ───────
//
// These skip msgpack/action_hash entirely: the struct is EIP-712-hashed
// directly under the HyperliquidSignTransaction domain (signatureChainId
// 0x66eee). Ports of `user_signed_payload` + the two SIGN_TYPES tables.

export const APPROVE_BUILDER_FEE_SIGN_TYPES = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'maxFeeRate', type: 'string' },
  { name: 'builder', type: 'address' },
  { name: 'nonce', type: 'uint64' },
];

export const USD_CLASS_TRANSFER_SIGN_TYPES = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'toPerp', type: 'bool' },
  { name: 'nonce', type: 'uint64' },
];

// Port of `user_signed_payload`. The message carries extra keys (type,
// signatureChainId) that aren't in signTypes; EIP-712 hashing pulls fields by
// name from the type list, so they're ignored in the hash but preserved for the
// HL submit body.
export function userSignedEip712(primaryType, signTypes, action) {
  const chainId = parseInt(action.signatureChainId, 16);
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: { [primaryType]: signTypes },
    primaryType,
    message: action,
  };
}

// Build an approveBuilderFee action (user-signed, master key). maxFeeRate is the
// HL percentage string (e.g. "0.008%"); builder is the lowercased address.
export function buildApproveBuilderFeeAction({ maxFeeRate, builder, nonce, network = hlNetwork() }) {
  return {
    action: {
      type: 'approveBuilderFee',
      hyperliquidChain: network,
      signatureChainId: '0x66eee',
      maxFeeRate,
      builder,
      nonce,
    },
    primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
    signTypes: APPROVE_BUILDER_FEE_SIGN_TYPES,
  };
}

// Build a usdClassTransfer action (Spot<->Perps, user-signed). amount is
// rendered like the SDK: up to 8 decimals, no trailing zeros / sci-notation.
export function buildUsdClassTransferAction({ amount, toPerp, nonce, network = hlNetwork() }) {
  // toFixed() switches to exponential notation from 1e21 up ("1e+21"), which
  // HL's amount parser rejects — and the failure would surface as an opaque
  // rejection after signing. An amount that large is a mistake either way, so
  // refuse here.
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e21) {
    throw new Error(
      `Invalid usdClassTransfer amount: ${amount}. Must be a positive number below 1e21.`,
    );
  }
  const strAmount = amount.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return {
    action: {
      type: 'usdClassTransfer',
      hyperliquidChain: network,
      signatureChainId: '0x66eee',
      amount: strAmount,
      toPerp,
      nonce,
    },
    primaryType: 'HyperliquidTransaction:UsdClassTransfer',
    signTypes: USD_CLASS_TRANSFER_SIGN_TYPES,
  };
}
