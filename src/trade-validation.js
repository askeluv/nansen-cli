/**
 * Trade input validation for the Nansen CLI.
 * Catches common agent errors (wrong addresses, same-token swaps,
 * bad amounts) before any network call.
 */

import { validateAddress } from './api.js';
import { CHAIN_RPCS } from './rpc-urls.js';
import { parseTransactionMessage, resolveStaticAccount } from './solana-tx.js';
import { SOL_SENTINEL } from './solana-simulation.js';

const SUPPORTED_CHAINS = ['solana', 'base'];

// SPL Token / Token-2022 instruction discriminators (first data byte) that can
// move control of a user's token account without moving its balance — the
// class of drain vector a balance-delta simulation can't see (see
// assertSolanaInstructionsSafe).
const SPL_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const SPL_APPROVE = 4;
const SPL_SET_AUTHORITY = 6;
const SPL_CLOSE_ACCOUNT = 9;
const SPL_APPROVE_CHECKED = 13;

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const COMPUTE_BUDGET_SET_UNIT_LIMIT = 2;
const COMPUTE_BUDGET_SET_UNIT_PRICE = 3;
const SOLANA_MAX_COMPUTE_UNITS = 1_400_000; // Solana's per-transaction compute-unit ceiling — the
                                             // worst-case bound used when a price is set with no
                                             // explicit limit instruction.
const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n; // 0.01 SOL sanity ceiling on the priority fee a
                                                // single trade can be made to pay.

/**
 * Validate quote inputs before any network call.
 * Throws on validation failure with an actionable error message.
 */
export function validateQuoteInput({ chain, toChain, from, to, amount }) {
  // 1. Chain must be supported
  const normalizedChain = chain?.toLowerCase();
  if (!SUPPORTED_CHAINS.includes(normalizedChain)) {
    throw new Error(
      `Unsupported chain "${chain}". Supported chains: ${SUPPORTED_CHAINS.join(', ')}.`
    );
  }

  const normalizedToChain = toChain ? toChain.toLowerCase() : normalizedChain;
  if (toChain && !SUPPORTED_CHAINS.includes(normalizedToChain)) {
    throw new Error(
      `Unsupported destination chain "${toChain}". Supported chains: ${SUPPORTED_CHAINS.join(', ')}.`
    );
  }

  // 2. Amount must be a positive finite number
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error(
      `Invalid amount "${amount}". Must be a positive number.`
    );
  }

  // 3. Token address format must match the chain (reuses api.js validateAddress)
  const fromResult = validateAddress(from, normalizedChain);
  if (!fromResult.valid) {
    throw new Error(
      `Invalid sell token address for ${normalizedChain}. ${fromResult.error}`
    );
  }
  const toResult = validateAddress(to, normalizedToChain);
  if (!toResult.valid) {
    throw new Error(
      `Invalid buy token address for ${normalizedToChain}. ${toResult.error}`
    );
  }

  // 4. Sell and buy token must be different (only applies to same-chain swaps)
  if (normalizedChain === normalizedToChain) {
    const fromNorm = normalizedChain === 'solana' ? from : from.toLowerCase();
    const toNorm = normalizedChain === 'solana' ? to : to.toLowerCase();
    if (fromNorm === toNorm) {
      throw new Error(
        `Cannot swap ${from} for itself. Sell and buy tokens must be different.`
      );
    }
  }

  // 5. At least one side must be USDC or the native token
  const fromIsAnchor = isUsdcOrNative(from, normalizedChain);
  const toIsAnchor = isUsdcOrNative(to, normalizedToChain);
  if (!fromIsAnchor && !toIsAnchor) {
    const anchorDesc = normalizedChain === normalizedToChain
      ? `USDC or the native token (${NATIVE_SYMBOLS[normalizedChain] ?? normalizedChain})`
      : `USDC or the native token on either side (${NATIVE_SYMBOLS[normalizedChain] ?? normalizedChain} on ${normalizedChain}, ${NATIVE_SYMBOLS[normalizedToChain] ?? normalizedToChain} on ${normalizedToChain})`;
    throw new Error(`Invalid swap: at least one token must be ${anchorDesc}. Got: ${from} → ${to}.`);
  }
}

// Native token decimals per chain (for converting balance from base units)
const NATIVE_DECIMALS = { solana: 9, base: 18 };

/**
 * Fetch the native token balance (ETH or SOL) for a wallet.
 * Returns balance in human-readable token units (e.g. 1.5 ETH), or null on RPC failure.
 *
 * Uses Number (not BigInt) for the result — acceptable precision loss for a
 * best-effort pre-check with 2% tolerance. Transaction amounts use BigInt elsewhere.
 */
export async function fetchNativeBalance(chain, walletAddress) {
  try {
    const rpcUrl = CHAIN_RPCS[chain];
    if (!rpcUrl) return null;

    const chainType = chain === 'solana' ? 'solana' : 'evm';

    if (chainType === 'evm') {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [walletAddress, 'latest'] }),
      });
      const body = await res.json();
      if (body.error || body.result === undefined) return null;
      const wei = BigInt(body.result);
      return Number(wei) / 10 ** NATIVE_DECIMALS[chain];
    }

    // Solana — getBalance returns { value: <lamports> }
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddress] }),
    });
    const body = await res.json();
    if (body.error || body.result?.value === undefined) return null;
    return body.result.value / 10 ** NATIVE_DECIMALS[chain];
  } catch {
    return null;
  }
}

// Addresses that represent native tokens (SOL, ETH) — not ERC-20/SPL contracts.
const NATIVE_TOKEN_ADDRESSES = {
  solana: 'So11111111111111111111111111111111111111112',
  base: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
};

// Native SOL has two on-chain spellings that denote the same asset: the
// canonical wrapped-SOL mint (what the CLI resolves `SOL` to and persists as
// the request intent) and the System Program address that aggregators and
// bridges (e.g. Relay) use as the native-lamport sentinel in their quotes.
// tokensEqual treats them as equivalent so the intent-binding check doesn't
// false-reject a legitimate quote that names native SOL the other way.
const SOLANA_NATIVE_SOL_ALIASES = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL mint
  '11111111111111111111111111111111', // System Program — native SOL sentinel
]);

// USDC contract addresses per chain.
const USDC_ADDRESSES = {
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};

// Native token symbols for error messages.
const NATIVE_SYMBOLS = { solana: 'SOL', base: 'ETH' };

const MIN_GAS_AMOUNTS = { solana: 0.01, base: 0.000024 };
const FEE_BUFFER = { solana: 0.005, base: 0.00004 };
const HIGH_PERCENTAGE_THRESHOLD = 95;
const AUTO_ADJUST_THRESHOLD_PERCENT = 2;

// Trades at or above this USD value can use gasless/solver-paid routes (e.g. Relay),
// so the native gas pre-check is skipped for them.
export const GASLESS_MIN_TRADE_USD = 10;

/**
 * Check if an address is USDC or the native token for a chain (case-insensitive for EVM).
 */
function isUsdcOrNative(address, chain) {
  const usdc = USDC_ADDRESSES[chain];
  const native = NATIVE_TOKEN_ADDRESSES[chain];
  if (!usdc && !native) return false;
  if (chain === 'solana') {
    return address === usdc || address === native;
  }
  // EVM: case-insensitive
  const lower = address.toLowerCase();
  return (usdc && lower === usdc.toLowerCase()) || (native && lower === native.toLowerCase());
}

/**
 * Check if an address is the native token for a chain (case-insensitive for EVM).
 */
function isNativeAddress(address, chain) {
  const native = NATIVE_TOKEN_ADDRESSES[chain];
  if (!native) return false;
  if (chain === 'solana') return address === native;
  return address.toLowerCase() === native.toLowerCase();
}

/**
 * Validate that the wallet has sufficient balance of the sell token.
 * Only applies when amountUnit is 'token' (human-readable amounts).
 *
 * Returns { adjustedAmount } — may differ from input if auto-adjusted
 * to 100% of balance (when amount exceeds balance by ≤2%).
 *
 * Throws on validation failure. Returns without action if RPC fails (best-effort).
 */
export async function validateBalance({ chain, from, amount, amountUnit, walletAddress, decimals, symbol: callerSymbol }) {
  // Only validate when amount is in token units — we can compare directly.
  if (amountUnit !== 'token') return { adjustedAmount: amount };

  const normalizedChain = chain.toLowerCase();
  const isNative = isNativeAddress(from, normalizedChain);
  const symbol = callerSymbol
    || (isNative ? NATIVE_SYMBOLS[normalizedChain] : null)
    || from;

  let balance;
  if (isNative) {
    balance = await fetchNativeBalance(normalizedChain, walletAddress);
  } else {
    if (decimals === undefined) return { adjustedAmount: amount };
    balance = await fetchTokenBalance(normalizedChain, from, walletAddress, decimals);
  }

  // Best-effort: if RPC failed, proceed without validation.
  if (balance === null) return { adjustedAmount: amount };

  // Check 1: wallet must hold the token
  if (balance === 0) {
    throw new Error(
      `No ${symbol} balance in wallet. You cannot trade a token you don't own.`
    );
  }

  // Check 2: amount vs balance
  let numAmount = Number(amount);
  if (numAmount > balance) {
    const excessPercent = ((numAmount - balance) / balance) * 100;
    if (excessPercent > AUTO_ADJUST_THRESHOLD_PERCENT) {
      throw new Error(
        `Insufficient balance. You have ${balance} ${symbol} but the trade requires ${amount} ${symbol}.`
      );
    }
    // Auto-adjust to 100% of balance
    const adjustedAmount = String(balance);
    numAmount = balance;
    process.stderr.write(
      `Warning: Amount ${amount} exceeds balance ${balance}. Auto-adjusting to ${adjustedAmount} ${symbol}.\n`
    );
    if (!isNative) return { adjustedAmount };
    // Native tokens fall through to the fee buffer check below — selling 100%
    // of a native balance still needs a gas reserve applied.
  }

  // Check 3: native token fee buffer when selling ≥95% of balance
  if (isNative) {
    const percentOfBalance = (numAmount / balance) * 100;
    if (percentOfBalance >= HIGH_PERCENTAGE_THRESHOLD) {
      const reserve = FEE_BUFFER[normalizedChain] || 0;
      const maxSellable = parseFloat((balance - reserve).toFixed(NATIVE_DECIMALS[normalizedChain]));
      if (maxSellable <= 0) {
        throw new Error(
          `Insufficient ${symbol} balance after reserving gas fees.`
        );
      }
      if (numAmount > maxSellable) {
        const adjustedAmount = String(maxSellable);
        process.stderr.write(
          `Warning: Reserving ${reserve} ${symbol} for gas. Adjusted sell amount to ${adjustedAmount} ${symbol}.\n`
        );
        return { adjustedAmount };
      }
    }
  }

  return { adjustedAmount: amount };
}

/**
 * Resolve a percentage amount to a token-unit amount string.
 * Fetches the wallet's balance of the sell token, calculates the percentage,
 * and applies a native-token fee buffer when selling >=95%.
 *
 * Returns the amount in human-readable token units (e.g. "1.5"),
 * ready for convertToBaseUnits().
 */
export async function resolvePercentAmount({ chain, from, walletAddress, percentage, decimals }) {
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error(
      percentage > 100
        ? `Cannot sell more than 100% of balance. Got: ${percentage}%`
        : `Percentage must be between 0 and 100. Got: ${percentage}%`
    );
  }

  const normalizedChain = chain.toLowerCase();
  const isNative = isNativeAddress(from, normalizedChain);

  let balance;
  if (isNative) {
    balance = await fetchNativeBalance(normalizedChain, walletAddress);
  } else {
    balance = await fetchTokenBalance(normalizedChain, from, walletAddress, decimals);
  }

  if (balance === null) {
    throw new Error(`Could not fetch balance for ${from} on ${normalizedChain}. Check your RPC connection.`);
  }
  if (balance === 0) {
    const symbol = isNative ? (NATIVE_SYMBOLS[normalizedChain] || from) : from;
    throw new Error(`No ${symbol} balance in wallet. You cannot trade a token you don't own.`);
  }

  // Calculate token amount from percentage.
  // Use exact balance for 100% to avoid floating-point precision loss.
  let tokenAmount = percentage === 100 ? balance : balance * (percentage / 100);

  // Native token fee buffer: when selling >=95%, cap at balance - reserve.
  if (isNative && percentage >= HIGH_PERCENTAGE_THRESHOLD) {
    const reserve = FEE_BUFFER[normalizedChain] || 0;
    const maxSellable = parseFloat((balance - reserve).toFixed(NATIVE_DECIMALS[normalizedChain]));
    if (maxSellable <= 0) {
      const symbol = NATIVE_SYMBOLS[normalizedChain] || from;
      throw new Error(`Insufficient ${symbol} balance after reserving gas fees.`);
    }
    if (tokenAmount > maxSellable) {
      const symbol = NATIVE_SYMBOLS[normalizedChain] || from;
      process.stderr.write(
        `Warning: Reserving ${reserve} ${symbol} for gas. Adjusted sell amount to ${maxSellable} ${symbol}.\n`
      );
      tokenAmount = maxSellable;
    }
  }

  return String(parseFloat(tokenAmount.toFixed(decimals)));
}

/**
 * Validate that the wallet has enough native token for gas fees.
 *
 * Returns { hasSufficientNative } or throws on validation failure.
 * Best-effort: if RPC fails, returns passing result.
 *
 * Gasless bypass: trades >= $10 USD can use solver-paid options (e.g. Relay),
 * so the gas check is skipped in that case.
 */
export async function validateGasBalance({ chain, walletAddress, tradeValueUsd }) {
  const normalizedChain = chain.toLowerCase();
  const minGas = MIN_GAS_AMOUNTS[normalizedChain];
  if (minGas === undefined) return { hasSufficientNative: true };

  // High-value trades can use gasless/solver-paid routes — skip the check.
  const tradeUsd = parseFloat(tradeValueUsd) || 0;
  if (tradeUsd >= GASLESS_MIN_TRADE_USD) return { hasSufficientNative: true };

  const balance = await fetchNativeBalance(normalizedChain, walletAddress);

  // RPC failure — proceed without validation.
  if (balance === null) return { hasSufficientNative: true };

  if (balance >= minGas) {
    return { hasSufficientNative: true };
  }

  const symbol = NATIVE_SYMBOLS[normalizedChain] || 'native token';
  throw new Error(
    `Insufficient ${symbol} for gas fees. Wallet has ${balance} ${symbol} but needs at least ${minGas} ${symbol}. Either fund the wallet with ${symbol} or trade a value of $${GASLESS_MIN_TRADE_USD}+ to use gasless options.`
  );
}

/**
 * Fetch an ERC-20 or SPL token balance for a wallet.
 * Returns balance in human-readable token units, or null on RPC failure.
 * Requires `decimals` to convert from base units.
 *
 * Uses Number (not BigInt) for the result — see fetchNativeBalance note on precision.
 */
export async function fetchTokenBalance(chain, tokenAddress, walletAddress, decimals) {
  try {
    const rpcUrl = CHAIN_RPCS[chain];
    if (!rpcUrl) return null;

    const chainType = chain === 'solana' ? 'solana' : 'evm';

    if (chainType === 'evm') {
      // balanceOf(address) selector = 0x70a08231, address padded to 32 bytes
      const paddedAddress = walletAddress.replace('0x', '').toLowerCase().padStart(64, '0');
      const data = '0x70a08231' + paddedAddress;
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddress, data }, 'latest'] }),
      });
      const body = await res.json();
      if (body.error || !body.result) return null;
      const raw = BigInt(body.result);
      return Number(raw) / 10 ** decimals;
    }

    // Solana — getTokenAccountsByOwner with the mint filter
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          { mint: tokenAddress },
          { encoding: 'jsonParsed' },
        ],
      }),
    });
    const body = await res.json();
    if (body.error) return null;
    const accounts = body.result?.value || [];
    if (accounts.length === 0) return 0;
    // Sum across all token accounts for this mint (rare but possible)
    let total = 0n;
    for (const acct of accounts) {
      const amount = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amount) total += BigInt(amount);
    }
    return Number(total) / 10 ** decimals;
  } catch {
    return null;
  }
}

// ============= ERC-20 approval calldata (hardened) =============

// uint256 ceiling. An allowance must be strictly below this: MAX_UINT256 itself
// is the "unlimited" sentinel we refuse to sign, and anything larger cannot
// encode in a 32-byte ABI word without overflowing into adjacent calldata.
export const MAX_UINT256 = (1n << 256n) - 1n;

// ERC-20 approve(address spender, uint256 amount) selector.
const APPROVE_SELECTOR = '0x095ea7b3';

/**
 * Validate that an approval spender is a well-formed, non-zero 20-byte EVM
 * address. A quote supplies this verbatim and it is concatenated into approval
 * calldata; anything other than `0x` + exactly 40 hex chars must be rejected
 * before encoding, because an over-length value would silently shift the ABI
 * word layout (turning a scoped approval into `approve(attacker, huge)`).
 *
 * @param {string} spender
 */
export function assertValidApprovalSpender(spender) {
  if (!spender || /^0x0+$/i.test(spender)) {
    throw new Error(
      `Approval spender is empty or the zero address (${spender ?? 'undefined'}). Refusing to sign an approval.`,
    );
  }
  if (typeof spender !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
    throw new Error(
      `Approval spender is not a valid 20-byte address (${spender}). Refusing to sign an approval.`,
    );
  }
}

/**
 * Encode `approve(spender, amount)` calldata with strict, defense-in-depth
 * bounds. This is the single encoder every signing path (local, Privy,
 * WalletConnect) must use, so no boundary can construct an under-validated
 * approval.
 *
 * Guarantees on the returned string:
 *   - spender is a valid 20-byte address (see assertValidApprovalSpender)
 *   - amount is a positive integer strictly below MAX_UINT256 (never unlimited),
 *     unless `allowZero` is explicitly set for a revoke-to-zero approval
 *   - amount does not exceed `maxAllowance` when the caller supplies one
 *     (the user's persisted request intent — see assertQuoteMatchesRequest)
 *   - the encoded calldata is exactly 68 bytes (4-byte selector + two 32-byte
 *     words), asserted after encoding so any width surprise fails closed
 *
 * @param {string} spender - Approval target (quote.approvalAddress)
 * @param {bigint|string|number} amount - Allowance in base units
 * @param {object} [opts]
 * @param {bigint|string|number} [opts.maxAllowance] - Hard cap from request intent
 * @param {boolean} [opts.allowZero=false] - Allow encoding a zero-amount revoke approval
 * @returns {string} 0x-prefixed approve() calldata (exactly 68 bytes)
 */
export function encodeApproveCalldata(spender, amount, { maxAllowance, allowZero = false } = {}) {
  assertValidApprovalSpender(spender);

  let amt;
  try {
    amt = BigInt(amount);
  } catch {
    throw new Error(`Approval amount is not an integer (${amount}). Refusing to sign an approval.`);
  }
  if (amt < 0n || (amt === 0n && !allowZero)) {
    throw new Error(`Approval amount must be positive (got ${amt}). Refusing to sign an approval.`);
  }
  if (amt >= MAX_UINT256) {
    throw new Error(
      `Approval amount ${amt} is at or above MAX_UINT256 (unlimited). Refusing to sign an unlimited approval.`,
    );
  }
  if (maxAllowance != null) {
    const cap = BigInt(maxAllowance);
    if (amt > cap) {
      throw new Error(
        `Approval amount ${amt} exceeds the request's maximum input ${cap}. Refusing to sign.`,
      );
    }
  }

  const data = APPROVE_SELECTOR
    + spender.slice(2).toLowerCase().padStart(64, '0')
    + amt.toString(16).padStart(64, '0');

  // 0x + 4-byte selector (8 hex) + two 32-byte words (128 hex) = 138 chars.
  const EXPECTED_LEN = 2 + 8 + 64 + 64;
  if (data.length !== EXPECTED_LEN) {
    throw new Error(
      `Encoded approval calldata is not 68 bytes (got ${(data.length - 2) / 2}). Refusing to sign.`,
    );
  }
  return data;
}

/**
 * Compute the ERC-20 allowance to grant for a swap — equivalently, the maximum
 * number of sell-token base units that can leave the wallet for this trade.
 *
 * Scoping the approval to the trade amount (instead of an unlimited MAX approval)
 * means a malicious or buggy quote can consume at most this one swap's input,
 * never the wallet's full token balance. exactIn pulls exactly the input amount;
 * exactOut can pull up to a slippage-bounded maximum, so that mode is buffered.
 *
 * This is the single definition of "what can leave the wallet": the approval
 * encoder scopes ERC-20 approvals to it, and assertInputWithinMax validates it
 * against the persisted spend ceiling. Keeping both on one function guarantees
 * a quote that clears the ceiling check can always be signed (a refactor can't
 * let the two drift onto different amounts).
 *
 * @param {object} p
 * @param {bigint|string|number} p.inputAmount - The swap's input amount (base units)
 * @param {string} [p.swapMode] - 'exactIn' (default) or 'exactOut'
 * @param {number} [p.slippage] - Slippage fraction for the exactOut buffer (default 0.03)
 * @returns {bigint} Allowance to approve, in base units
 */
export function approvalAmountForSwap({ inputAmount, swapMode, slippage }) {
  // Clamp non-positive / malformed amounts to 0n — a negative like "-5000000",
  // or a non-integer string like "1.5" / "1.5e6" that BigInt() rejects — so
  // callers can reject via a single `approveAmt <= 0n` check and a negative or
  // invalid value never reaches hex encoding (which would mangle the calldata).
  let amt;
  try {
    amt = BigInt(inputAmount ?? 0);
  } catch {
    return 0n;
  }
  if (amt <= 0n) return 0n;
  if (swapMode === 'exactOut') {
    // Honour an explicit slippage of 0 (tightest approval); only fall back to the
    // 3% default when slippage wasn't provided (undefined/NaN) or is negative.
    const slip = Number.isFinite(slippage) && slippage >= 0 ? slippage : 0.03;
    // Buffer by slippage using basis-point integer math to stay in BigInt.
    // Both steps round UP by design: this buffer must cover the router's max
    // input for exactOut, so over-approving by a sub-token unit is harmless but
    // under-approving by even 1 unit would revert the swap. Rounding up on both
    // the bps conversion and the division guarantees we never land below
    // (1 + slip) * amount.
    const bps = BigInt(Math.ceil((1 + slip) * 10000));
    const buffered = (amt * bps + 9999n) / 10000n; // ceil division
    // Overflow guard: a huge input × slippage can exceed the uint256 ceiling,
    // which encodeApproveCalldata would reject with a cryptic throw. Return 0n
    // so the caller's `approveAmt <= 0n` check surfaces it as a clear
    // zero/invalid-input skip instead.
    if (buffered >= MAX_UINT256) return 0n;
    return buffered;
  }
  return amt;
}

// Existing allowances above this multiple of the current trade's scoped amount
// are treated as stale/oversized rather than reusable dust from a prior swap.
export const OVERSIZED_ALLOWANCE_MULTIPLIER = 10n;

/**
 * Decide whether an existing on-chain ERC-20 allowance should be revoked before
 * granting the current trade's scoped approval.
 *
 * @param {bigint} existingAllowance - Current on-chain allowance
 * @param {bigint} approveAmt - This trade's scoped approval amount
 * @returns {boolean}
 */
export function needsAllowanceRevoke(existingAllowance, approveAmt) {
  if (approveAmt <= 0n) return false;
  return existingAllowance > approveAmt * OVERSIZED_ALLOWANCE_MULTIPLIER;
}

// ============= Quote vs. request-intent revalidation =============

/**
 * Compare two token addresses for equality (case-insensitive on EVM, exact on
 * Solana except for the native-SOL sentinel aliasing above). Missing values
 * never match.
 */
function tokensEqual(a, b, chain) {
  if (!a || !b) return false;
  if (chain === 'solana') {
    // Both sides naming native SOL (in either spelling) is a match.
    if (SOLANA_NATIVE_SOL_ALIASES.has(a) && SOLANA_NATIVE_SOL_ALIASES.has(b)) return true;
    return a === b;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Revalidate a quote against the immutable request intent that was persisted
 * when the quote was fetched. The Trading API supplies the amounts, token
 * pair, and transaction that the execute path signs; without this check a
 * compromised or buggy API could inflate the input amount (and therefore the
 * scoped approval and native value) and still pass the execute path's own
 * self-consistent comparisons.
 *
 * Binds the fields we can verify from the quote:
 *   - chain identity
 *   - token pair (input == requested sell token, output == requested buy token)
 *   - exactIn: input amount EQUALS the requested amount (the spend ceiling)
 *   - exactOut: output amount EQUALS the requested amount (what you buy)
 *   - input <= request.maxInputAmount in BOTH modes (the spend ceiling). For
 *     exactOut this cap is the ONLY thing bounding the input, so it is
 *     mandatory — a quote with no persisted cap is refused (see
 *     assertInputWithinMax).
 *
 * Fails closed on a quote that is missing a field this check needs (input or
 * output token address, or the bound amount): the field can't silently skip
 * its comparison, because a compromised API omitting it would otherwise
 * bypass the very binding meant to constrain it.
 *
 * Throws on a definitive mismatch. Callers run this inside the per-quote try so
 * a mismatched quote falls through to the next candidate.
 *
 * @param {object|undefined} request - Persisted intent (quoteData.request)
 * @param {object} quote - The quote being executed (allQuotes[i])
 * @param {object} ctx
 * @param {string} ctx.chain - Execute chain
 * @param {string} [ctx.walletAddress] - The address that will actually sign at
 *   execute time. When both this and request.walletAddress are present they must
 *   match: the quote's transaction was built for a specific sender, so signing it
 *   from a different wallet (e.g. the default wallet changed since quoting) is
 *   refused. Omit when the signer isn't known (the check is then skipped).
 * @param {number} [ctx.slippage] - Slippage fraction in effect (quoteData.slippage),
 *   forwarded to assertInputWithinMax so the exactOut spend ceiling is measured
 *   against the buffered approval, not the raw quote input.
 * @returns {{ skipped: boolean }} skipped=true when no intent was persisted
 */
export function assertQuoteMatchesRequest(request, quote, { chain, walletAddress, slippage } = {}) {
  // Quotes saved by an older CLI version (pre-intent) legitimately lack a
  // request block. Rather than brick an in-flight quote across an upgrade, we
  // skip and let the caller warn; quotes expire in 1 hour so this is transient.
  if (!request) return { skipped: true };

  if (request.chain && request.chain.toLowerCase() !== String(chain).toLowerCase()) {
    throw new Error(
      `Quote chain (${chain}) does not match the requested chain (${request.chain}). Refusing to sign.`,
    );
  }

  const tokenChain = String(chain).toLowerCase();

  // Bind the signer to the wallet the quote was built for. The Trading API
  // builds transaction `to`/`data` (and recipient) for a specific sender; a
  // wallet swapped in between quote and execute would sign someone else's quote.
  if (request.walletAddress && walletAddress) {
    const addrsEqual = tokenChain === 'solana'
      ? request.walletAddress === walletAddress
      : request.walletAddress.toLowerCase() === walletAddress.toLowerCase();
    if (!addrsEqual) {
      throw new Error(
        `Quote was built for wallet ${request.walletAddress} but the signer is ${walletAddress}. The default wallet may have changed since quoting. Re-quote with this wallet. Refusing to sign.`,
      );
    }
  }
  if (request.fromToken) {
    // A missing sell-token address must fail closed: without it the token-pair
    // binding below can't run, so we can't confirm the quote sells what was asked.
    if (!quote.inputMint) {
      throw new Error(
        `Quote is missing the sell-token address (inputMint); cannot confirm it matches the requested ${request.fromToken}. Refusing to sign.`,
      );
    }
    if (!tokensEqual(quote.inputMint, request.fromToken, tokenChain)) {
      throw new Error(
        `Quote sell token (${quote.inputMint}) does not match the requested token (${request.fromToken}). Refusing to sign.`,
      );
    }
  }
  // The output token lives on the destination chain, which differs from the
  // source chain for cross-chain swaps. Compare it with the destination chain's
  // case rules (Solana base58 is case-sensitive) to avoid false rejections.
  const outTokenChain = request.toChain ? String(request.toChain).toLowerCase() : tokenChain;
  if (request.toToken) {
    // Fail closed on a missing buy-token address for the same reason. Previously
    // a missing outputMint silently skipped this comparison — a compromised API
    // could omit it to route the output somewhere else undetected.
    if (!quote.outputMint) {
      throw new Error(
        `Quote is missing the buy-token address (outputMint); cannot confirm it matches the requested ${request.toToken}. Refusing to sign.`,
      );
    }
    if (!tokensEqual(quote.outputMint, request.toToken, outTokenChain)) {
      throw new Error(
        `Quote buy token (${quote.outputMint}) does not match the requested token (${request.toToken}). Refusing to sign.`,
      );
    }
  }

  if (request.amount != null) {
    const requested = BigInt(request.amount);
    if (request.swapMode === 'exactOut') {
      // Require the output amount to be present; a missing value must not
      // default to 0 and coincidentally pass some other comparison.
      const outRaw = quote.outAmount ?? quote.outputAmount;
      if (outRaw == null) {
        throw new Error(
          `Quote is missing the output amount; cannot confirm it matches the requested output (${requested}). Refusing to sign.`,
        );
      }
      const out = BigInt(outRaw);
      // Require AT LEAST the requested output. More output for a capped input
      // (see assertInputWithinMax) is pure upside, so only a shortfall is a
      // mismatch — enforcing strict equality would false-reject benign rounding.
      if (out < requested) {
        throw new Error(
          `Quote output amount (${out}) is less than the requested output (${requested}). Refusing to sign.`,
        );
      }
    } else {
      const inRaw = quote.inputAmount ?? quote.inAmount;
      if (inRaw == null) {
        throw new Error(
          `Quote is missing the input amount; cannot confirm it matches the requested input (${requested}). Refusing to sign.`,
        );
      }
      const input = BigInt(inRaw);
      if (input !== requested) {
        throw new Error(
          `Quote input amount (${input}) does not match the requested input (${requested}). A larger input would enlarge the approval and native value beyond what you asked to spend. Refusing to sign.`,
        );
      }
    }
  }

  // Independent spend ceiling on the input, enforced in both modes. This is the
  // sole guard on exactOut input (which request.amount binds only on the output
  // side), so it fails closed when an exactOut quote carries no persisted cap.
  assertInputWithinMax(request, quote, slippage);

  return { skipped: false };
}

/**
 * Enforce the maximum input (the spend ceiling) persisted in the request intent
 * against the quote the execute path is about to sign. This bounds the tokens
 * that can leave the wallet independently of the output binding, closing the
 * exactOut gap where the API chooses the input and nothing capped it.
 *
 * The amount compared against the cap is the maximum that can actually leave the
 * wallet — for exactOut that is the slippage-buffered spend, NOT the raw quote
 * input. On EVM the approval encoder (encodeApproveCalldata) scopes the ERC-20
 * approval to that same buffered amount and caps it at maxInputAmount, so
 * validating the raw input here would let a quote pass this check and then be
 * refused at signing (a 1,000,000 input at 3% slippage needs a 1,030,000
 * approval, which a 1,000,000 cap rejects). On Solana there is no approval step,
 * but the swap can still consume up to that buffered amount, so the same ceiling
 * applies. Comparing the amount approvalAmountForSwap produces keeps this check
 * consistent with what the execute path can actually spend.
 *
 * Behaviour:
 *   - exactOut with no persisted `maxInputAmount` → throws (fail closed). The
 *     input is otherwise unbounded, so signing without a cap is refused.
 *   - a persisted cap with a missing/invalid quote input → throws. A cap you
 *     can't compare against is not a cap.
 *   - buffered spend > cap → throws. A larger approval/native value would let
 *     more than the user approved leave the wallet.
 *   - exactIn with no cap → no-op (request.amount already binds the input).
 *
 * Applies to native, ERC-20, and Solana swaps alike (Solana has no approval step,
 * so the "buffered spend" ceiling is just the spend itself); the caller runs it
 * before any approval, transaction signing, or WalletConnect call.
 *
 * @param {object} request - Persisted intent (quoteData.request)
 * @param {object} quote - The quote being executed
 * @param {number} [slippage] - Slippage fraction actually in effect (quoteData.slippage),
 *   used to reconstruct the exactOut buffer. Defaults to approvalAmountForSwap's
 *   3% when omitted, matching the approval the execute path would build.
 */
export function assertInputWithinMax(request, quote, slippage) {
  if (!request) return;
  const swapMode = request.swapMode ?? 'exactIn';
  if (request.maxInputAmount == null) {
    if (swapMode === 'exactOut') {
      throw new Error(
        'exactOut quote has no persisted maximum input (maxInputAmount); the input is otherwise unbounded. Re-quote to enable the spend cap. Refusing to sign.',
      );
    }
    return; // exactIn input is already bound by request.amount.
  }

  let cap;
  try {
    cap = BigInt(request.maxInputAmount);
  } catch {
    throw new Error(
      `Persisted maximum input (${request.maxInputAmount}) is not an integer. Refusing to sign.`,
    );
  }

  const inRaw = quote.inputAmount ?? quote.inAmount;
  if (inRaw == null) {
    throw new Error(
      'Quote is missing the input amount; cannot enforce the maximum input. Refusing to sign.',
    );
  }
  let input;
  try {
    input = BigInt(inRaw);
  } catch {
    throw new Error(
      `Quote input amount (${inRaw}) is not an integer; cannot enforce the maximum input. Refusing to sign.`,
    );
  }

  // The tokens that can actually leave the wallet: exactIn pulls the raw input,
  // exactOut pulls up to the slippage-buffered approval. Bound THAT against the
  // cap so this check agrees with the approval encoder (see docstring).
  const spend = approvalAmountForSwap({ inputAmount: input, swapMode, slippage });
  if (spend <= 0n && input > 0n) {
    // exactOut buffer overflowed the uint256 ceiling (approvalAmountForSwap
    // returns 0n) — an unbounded approval, never signable.
    throw new Error(
      `Quote input amount (${input}) plus the slippage buffer overflows the uint256 approval ceiling; cannot enforce the maximum input. Refusing to sign.`,
    );
  }
  if (spend > cap) {
    // Normalize case: request.chain is persisted verbatim from the user's
    // --chain input (e.g. `--chain Solana`), so an exact === would mislabel a
    // Solana swap with the EVM-worded (approval/native-value) message.
    const isSolana = String(request.chain).toLowerCase() === 'solana';
    throw new Error(
      swapMode === 'exactOut'
        ? isSolana
          ? `Quote needs ${spend} base units (input ${input} + slippage buffer) to guarantee the exact output, which exceeds your maximum input (${cap}). Raise --max-input or lower the requested output. Refusing to sign.`
          : `Quote needs an approval of ${spend} base units (input ${input} + slippage buffer) to guarantee the exact output, which exceeds your maximum input (${cap}). Raise --max-input or lower the requested output. Refusing to sign.`
        : isSolana
          ? `Quote input amount (${input}) exceeds your maximum input (${cap}). Refusing to sign.`
          : `Quote input amount (${input}) exceeds your maximum input (${cap}). A larger input would enlarge the approval and native value beyond what you approved. Refusing to sign.`,
    );
  }
}

// ============= Swap-calldata shape guard (same-chain) =============

// Bare ERC-20 methods a legitimate same-chain swap's OUTER call never uses. A
// real swap routes through an aggregator/router (swap/execute/multicall); if the
// quote's swap `transaction.data` starts with one of these selectors, the call
// is a direct token transfer/approval disguised as a swap — the drain shape.
//
// Because the user's wallet is msg.sender, `transfer`/`transferFrom(from=user)`
// move the user's own tokens with no prior allowance, and `approve` hands an
// attacker a fresh allowance — so blocking these outer selectors closes the
// direct sibling-token drain. It does NOT catch a custom contract exploiting a
// pre-existing allowance; that needs outcome (balance-delta) simulation.
//
// The caller runs this SELECTOR check on same-chain swaps only. Cross-chain
// routes are excluded from THIS check because a bridge deposit can, in
// principle, encode as a plain `transfer` — but that does NOT mean a cross-chain
// bare transfer is waved through: a bare ERC-20 `transfer`/`approve` targets the
// token contract itself, so `validateSwapTarget`'s `to === inputMint` gate still
// refuses it, for cross-chain and same-chain alike (fail closed). In practice
// the bridge routes this CLI uses (Relay/Li.Fi) route ERC-20 deposits through a
// router contract (to != token), so neither guard fires on a legitimate bridge.
// Safely supporting a genuine deposit-as-transfer bridge would require positive
// recipient/amount validation (balance-delta outcome simulation), not a blanket
// exemption — tracked as a follow-up.
const BARE_ERC20_OUTER_SELECTORS = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
};

/**
 * Reject a swap or bridge whose transaction calldata is a bare ERC-20
 * transfer/approve/transferFrom rather than a router call. Applies to both
 * same-chain and cross-chain EVM quotes (a legit bridge also routes through a
 * router). No-op when the calldata is absent or too short to carry a 4-byte
 * selector.
 *
 * @param {string} data - The swap transaction's calldata (quote.transaction.data)
 */
export function assertSwapCalldataNotBareTransfer(data) {
  if (!data || typeof data !== 'string' || data.length < 10) return;
  const selector = data.slice(0, 10).toLowerCase();
  const method = BARE_ERC20_OUTER_SELECTORS[selector];
  if (method) {
    throw new Error(
      `Swap transaction is a bare ERC-20 ${method}, not a routed swap. A real swap routes through an aggregator, not a direct token transfer/approval. Refusing to sign.`,
    );
  }
}

// ============= Swap-outcome verification (balance-delta simulation) =============

/**
 * A cross-chain bridge's output settles on the destination chain, invisible to
 * a source-chain simulation, so the output-arrival assertion is meaningless
 * for one and both assert...SwapOutcome functions skip it via this check.
 * Derived from the immutable persisted request intent (not the loose
 * quote/quoteData) so it can't drift between calls or across chains.
 */
function isBridgeRequest(request) {
  return request.toChain != null
    && String(request.toChain).toLowerCase() !== String(request.chain).toLowerCase();
}

/**
 * Assert that a SIMULATED swap's asset changes match the user's intent, failing
 * closed on any mismatch. This is a defence-in-depth outcome check that
 * complements the static calldata checks (validateSwapTarget /
 * assertSwapCalldataNotBareTransfer): it verifies what the swap actually does to
 * the wallet's balances, not just what the calldata looks like.
 *
 * Run it on the swap-call-alone simulation AFTER any required approval is
 * confirmed on-chain, so the live allowance is reflected on `latest` and a
 * single-transaction sim matches the broadcast swap (see swap-simulation.js).
 *
 * Four assertions, all derived from the persisted request intent + the quote:
 *   1. the input token leaves the wallet by no MORE than maxInputAmount. Native
 *      input excludes gas: the sim deltas are log-based, so gas (not a transfer
 *      log) is never counted.
 *   2. the output token arrives by AT LEAST minOut — exactOut: >= the requested
 *      output; exactIn: the quoted output reduced by the slippage in effect.
 *      SKIPPED for a cross-chain bridge: the output settles on the destination
 *      chain and can never appear in a source-chain simulation.
 *   3. NO token other than the input leaves the wallet.
 *   4. the wallet grants no Approval to a spender outside `expectedSpenders`.
 *
 * @param {object} request - persisted intent (quoteData.request); required
 * @param {object} quote - the quote being executed
 * @param {{deltas: Record<string, bigint|string|number>, approvals?: Array<{token?:string, spender?:string, amount?:any}>}} sim
 *   - the normalised result from simulateAssetChanges()
 * @param {object} [ctx]
 * @param {number} [ctx.slippage] - slippage fraction in effect (quoteData.slippage);
 *   defaults to 3% to match approvalAmountForSwap when omitted
 * @param {Set<string>|string[]} [ctx.expectedSpenders] - spenders the wallet may
 *   legitimately (re)approve during the swap (e.g. the approval target and the
 *   router); anything else fails assertion 4. Compared case-insensitively.
 * @param {bigint} [ctx.siblingDustThreshold=0n] - non-input outflow tolerated
 *   before assertion 3 fires (for fee-on-transfer / rounding). Strict 0 default.
 * @returns {{verified: true, outputAssertionSkipped: boolean}} outputAssertionSkipped
 *   is true for a cross-chain bridge, meaning assertion 2 did not run — the
 *   caller should surface this.
 * @throws {Error} with `code = 'SWAP_OUTCOME_MISMATCH'` on any failed assertion.
 */
export function assertSwapOutcome(request, quote, sim, { slippage, expectedSpenders, siblingDustThreshold = 0n } = {}) {
  const fail = (detail) => {
    const e = new Error(`Swap outcome mismatch (SWAP_OUTCOME_MISMATCH): ${detail} Refusing to sign.`);
    e.code = 'SWAP_OUTCOME_MISMATCH';
    return e;
  };

  if (!request) throw fail('no request intent to verify the outcome against.');
  if (!sim || typeof sim !== 'object' || sim.deltas == null) {
    throw fail('simulation returned no asset changes to verify.');
  }

  // Normalise deltas to a lowercased-key BigInt map. A non-integer delta is a
  // corrupt sim result — fail closed rather than coerce it to 0.
  const deltas = {};
  for (const [k, v] of Object.entries(sim.deltas)) {
    let amt;
    try {
      amt = typeof v === 'bigint' ? v : BigInt(v);
    } catch {
      throw fail(`simulated delta for ${k} (${v}) is not an integer.`);
    }
    deltas[k.toLowerCase()] = amt;
  }

  const inputToken = quote?.inputMint ? String(quote.inputMint).toLowerCase() : null;
  const outputToken = quote?.outputMint ? String(quote.outputMint).toLowerCase() : null;
  if (!inputToken || !outputToken) {
    throw fail('quote is missing the input or output token address.');
  }
  // Fail closed on a same-token quote: assertion 3 skips the input token, so if
  // output == input a drain of that token would slip past unverified. A real
  // swap never sells and buys the same token (also rejected upstream).
  if (inputToken === outputToken) {
    throw fail(`quote input and output tokens are the same (${inputToken}); refusing to verify.`);
  }

  // Bridges skip only assertion 2 (output arrival) below — see isBridgeRequest.
  const isBridge = isBridgeRequest(request);

  // --- Assertion 1: input outflow within the spend ceiling ---
  // This bounds the outflow by maxInputAmount (the slippage-buffered ceiling),
  // NOT the exact expected input: for exactOut the aggregator may legitimately
  // pull anywhere up to that ceiling. The tighter exactIn bound (outflow ==
  // request.amount) is enforced by assertQuoteMatchesRequest, which the execute
  // paths run earlier in the same iteration. Keep that call ahead of this one on
  // any new signing path — Assertion 1 alone does not re-check exactIn inflation.
  if (request.maxInputAmount == null) {
    throw fail('request has no maximum input to bound the outflow against.');
  }
  let cap;
  try {
    cap = BigInt(request.maxInputAmount);
  } catch {
    throw fail(`maximum input (${request.maxInputAmount}) is not an integer.`);
  }
  const inputDelta = deltas[inputToken] || 0n;
  const outflow = inputDelta < 0n ? -inputDelta : 0n;
  if (outflow > cap) {
    throw fail(`the input token (${inputToken}) left the wallet by ${outflow}, exceeding your maximum input (${cap}).`);
  }

  // --- Assertion 2: output arrives at or above the minimum acceptable ---
  // Skipped entirely for a bridge: the output settles on the destination
  // chain, so it can never appear in this source-chain simulation.
  if (!isBridge) {
    const swapMode = request.swapMode ?? 'exactIn';
    const outputDelta = deltas[outputToken] || 0n;
    let minOut;
    if (swapMode === 'exactOut') {
      if (request.amount == null) throw fail('exactOut request is missing the requested output amount.');
      try {
        minOut = BigInt(request.amount);
      } catch {
        throw fail(`requested output amount (${request.amount}) is not an integer.`);
      }
      // Mirror the exactIn non-positive guard: a zero/negative requested output
      // makes minOut <= 0 and turns assertion 2 into a no-op (outputDelta >= 0
      // always holds), so a swap delivering nothing would pass. Upstream rejects
      // zero amounts, but this helper is a self-contained fail-closed boundary.
      if (minOut <= 0n) {
        throw fail(`exactOut request has a non-positive output amount (${minOut}); cannot compute a minimum acceptable output.`);
      }
    } else {
      const quotedRaw = quote.outAmount ?? quote.outputAmount;
      if (quotedRaw == null) {
        throw fail('quote is missing the quoted output amount; cannot compute the minimum acceptable output.');
      }
      let quoted;
      try {
        quoted = BigInt(quotedRaw);
      } catch {
        throw fail(`quoted output amount (${quotedRaw}) is not an integer.`);
      }
      // A non-positive quoted output makes minOut <= 0, so a sim receiving nothing
      // (or losing the output token) would pass assertion 2 (outputDelta < minOut is
      // false when minOut <= 0). exactIn has no upstream positive-output guard
      // (unlike exactOut), so a rogue outAmount of "0" or a negative value would
      // otherwise slip through.
      if (quoted <= 0n) {
        throw fail(`quote has a non-positive output amount (${quoted}); cannot compute a minimum acceptable output.`);
      }
      // Floor of quoted × (1 − slippage), in basis points to stay in BigInt. This
      // mirrors the slippage the user actually set (quoteData.slippage), defaulting
      // to 3% to match approvalAmountForSwap when it wasn't supplied.
      //
      // Cap the slippage used HERE at 50%, independent of what the user accepted:
      // the upstream quote command allows --slippage up to 1.0 (100%), which would
      // make minOut 0 and neuter this assertion — a route delivering nothing would
      // pass (outputDelta >= 0). This is a defence-in-depth floor, not the user's
      // execution tolerance; a real swap never loses more than half the quoted
      // output, so requiring at least 50% keeps the guard meaningful while leaving
      // enormous headroom over a normal few-percent deviation.
      const rawSlip = Number.isFinite(slippage) && slippage >= 0 ? slippage : 0.03;
      const slip = Math.min(rawSlip, 0.5);
      const bps = BigInt(Math.min(10000, Math.round(slip * 10000)));
      minOut = (quoted * (10000n - bps)) / 10000n;
    }
    if (outputDelta < minOut) {
      throw fail(`the output token (${outputToken}) increased by only ${outputDelta}, below the minimum acceptable output (${minOut}).`);
    }
  }

  // --- Assertion 3: no token other than the input leaves the wallet ---
  const dust = siblingDustThreshold > 0n ? siblingDustThreshold : 0n;
  for (const [token, delta] of Object.entries(deltas)) {
    if (token === inputToken) continue; // its outflow is bounded by assertion 1
    if (delta < 0n && -delta > dust) {
      throw fail(`a token other than the one you are selling (${token}) left the wallet (delta ${delta}); a swap must not move any token except the input.`);
    }
  }

  // --- Assertion 3b: no non-fungible asset leaves the wallet ---
  // The signed `deltas` map only models native + ERC-20 balances, so an NFT
  // drain is invisible to assertion 3. A DEX swap should never move an ERC-721 or
  // ERC-1155 out of the wallet, so fail closed if the sim surfaced one. (Inbound
  // NFTs are harmless and are not recorded by foldLogs.)
  for (const nft of sim.nftOut || []) {
    throw fail(
      `a non-fungible asset (${nft.standard}${nft.token ? ` ${nft.token}` : ''}) left the wallet; a swap must not transfer any NFT.`,
    );
  }

  // --- Assertion 3c: no non-fungible approval is granted ---
  // A DEX swap never needs to approve an NFT, so any ERC-721 / ERC-1155 approval
  // the wallet grants (single-token Approval or ApprovalForAll) is fail-closed —
  // it would let the operator move the NFT out AFTER the swap, invisibly to the
  // transfer checks above. The ERC-20 spender allowlist (assertion 4) does NOT
  // cover these: a single-NFT Approval folds in as a zero-amount "revoke" and an
  // ApprovalForAll is not an ERC-20 Approval at all.
  for (const ap of sim.nftApprovals || []) {
    throw fail(
      `the swap grants a non-fungible approval (${ap.standard}${ap.token ? ` ${ap.token}` : ''}) to ${ap.operator || 'an operator'}; a swap must not approve any NFT.`,
    );
  }

  // --- Assertion 4: no approval to an unexpected spender ---
  const allowed = new Set(
    (expectedSpenders instanceof Set ? [...expectedSpenders] : expectedSpenders || [])
      .filter(Boolean)
      .map((s) => String(s).toLowerCase()),
  );
  for (const ap of sim.approvals || []) {
    if (!ap || !ap.spender) continue;
    // A revoke (approve to 0) grants no allowance, so it is never a concern.
    if (ap.amount != null) {
      try {
        if (BigInt(ap.amount) === 0n) continue;
      } catch { /* non-integer amount → treat as a real approval below */ }
    }
    const spender = String(ap.spender).toLowerCase();
    if (!allowed.has(spender)) {
      throw fail(
        `the swap grants an approval to an unexpected spender (${spender}); a swap should only (re)approve ${allowed.size ? [...allowed].join(', ') : 'nothing'}.`,
      );
    }
  }

  return { verified: true, outputAssertionSkipped: isBridge };
}

// Native-SOL dust tolerated on a non-input sibling in assertSolanaSwapOutcome —
// covers the base tx fee plus one transient ATA's rent (e.g. a WSOL account
// opened and closed within the swap). SPL-token siblings get no such tolerance
// (dust threshold 0n); only native SOL legitimately moves as a byproduct of fees
// and rent rather than the swap itself.
const NATIVE_SIBLING_DUST_LAMPORTS = 3_000_000n; // ~0.003 SOL

// Full native-SOL fee/rent noise budget: the dust above PLUS the priority fee
// a transaction may legitimately pay, up to the ceiling assertSolanaInstructionsSafe
// enforces. NATIVE_SIBLING_DUST_LAMPORTS alone only covers the base fee + rent —
// a real, legal priority fee (anywhere up to MAX_PRIORITY_FEE_LAMPORTS) also
// leaves the wallet as native SOL regardless of whether SOL is the input,
// output, or an uninvolved sibling of the swap, so all three assertions below
// need the same combined slack or a legitimate high-priority-fee trade false-blocks.
const NATIVE_FEE_RENT_SLACK_LAMPORTS = MAX_PRIORITY_FEE_LAMPORTS + NATIVE_SIBLING_DUST_LAMPORTS;

/**
 * The Solana sibling of assertSwapOutcome. Solana signs the aggregator's
 * serialized transaction verbatim and has no approval/calldata split to
 * validate, so this verifies the balance-delta simulation result (see
 * solana-simulation.js) against the persisted request intent directly.
 *
 * REQUIRES assertSolanaInstructionsSafe to have already run, RPC-free, on the
 * same transaction (both current signing paths in trading.js call it first):
 * an unexpected authority grant is rejected there (no assertion 4 sibling
 * needed here), and assertion 1's native-input slack below is only a safe
 * bound because that check has already enforced the priority-fee ceiling —
 * skip it on any future signing path and native-input drains widen from a
 * fixed slack to an unbounded priority fee.
 *
 * Three assertions:
 *   1. the input token leaves the wallet by no more than maxInputAmount.
 *      Native-SOL input can't be bound at the exact cap the way an SPL input
 *      can: its lamport delta also carries the base fee, priority fee, and net
 *      ATA rent (opened minus reclaimed), which is too noisy for a tight
 *      bound. It is still bounded, not skipped — the cap is relaxed by a
 *      fee/rent slack (the priority-fee ceiling assertSolanaInstructionsSafe
 *      enforces, plus one transient ATA's rent) so a real outflow beyond any
 *      realistic transaction cost is still caught. Without this, a
 *      transaction with an extra unaccounted native-SOL outflow (e.g. a plain
 *      System-Program transfer, which assertSolanaInstructionsSafe does not
 *      classify) would sail through as long as the declared output arrived —
 *      neither assertQuoteMatchesRequest (checks the quote's declared
 *      metadata, not the transaction's real effects) nor assertion 3 (which
 *      exempts the input asset, assuming assertion 1 already bounded it)
 *      would catch it.
 *   2. the output token arrives by at least the minimum acceptable amount.
 *      Native-SOL output relaxes this floor by NATIVE_FEE_RENT_SLACK_LAMPORTS
 *      because its lamport delta also nets out the base fee, priority fee, and
 *      ATA rent (same noise as native input); SPL output keeps the exact floor.
 *      SKIPPED for a cross-chain bridge: the output settles on the destination
 *      chain and can never appear in a source-chain simulation.
 *   3. no OTHER tracked asset leaves the wallet. SPL-token siblings get zero
 *      tolerance; native SOL, when it's a sibling (not the input), tolerates
 *      NATIVE_FEE_RENT_SLACK_LAMPORTS of fee/rent dust. All three assertions
 *      share this one slack value — splitting it (e.g. a smaller tolerance for
 *      assertion 2/3 than assertion 1) would false-block a legitimate trade
 *      paying close to the priority-fee ceiling on whichever assertion has the
 *      smaller number, since the same fee leaves the wallet as native SOL
 *      regardless of SOL's role in that particular swap.
 *
 * @param {object} request - persisted intent (quoteData.request); required
 * @param {object} quote - the quote being executed
 * @param {{deltas: Record<string, bigint|string|number>}} sim - the normalised
 *   result from simulateSolanaAssetChanges()
 * @param {object} [ctx]
 * @param {number} [ctx.slippage] - slippage fraction in effect; defaults to 3%
 * @param {bigint} [ctx.siblingDustThreshold] - overrides NATIVE_FEE_RENT_SLACK_LAMPORTS
 * @returns {{verified: true, inputAssertionSkipped: boolean, outputAssertionSkipped: boolean}}
 *   inputAssertionSkipped is true when the input was native SOL, meaning
 *   assertion 1 ran with the fee/rent slack applied instead of an exact bound
 *   (see assertion 1's rationale above). outputAssertionSkipped is true for a
 *   cross-chain bridge, meaning assertion 2 did not run. The caller should
 *   surface both.
 * @throws {Error} with `code = 'SWAP_OUTCOME_MISMATCH'` on any failed assertion.
 */
export function assertSolanaSwapOutcome(request, quote, sim, { slippage, siblingDustThreshold } = {}) {
  const fail = (detail) => {
    const e = new Error(`Swap outcome mismatch (SWAP_OUTCOME_MISMATCH): ${detail} Refusing to sign.`);
    e.code = 'SWAP_OUTCOME_MISMATCH';
    return e;
  };

  if (!request) throw fail('no request intent to verify the outcome against.');
  if (!sim || typeof sim !== 'object' || sim.deltas == null) {
    throw fail('simulation returned no asset changes to verify.');
  }

  const deltas = {};
  for (const [k, v] of Object.entries(sim.deltas)) {
    let amt;
    try {
      amt = typeof v === 'bigint' ? v : BigInt(v);
    } catch {
      throw fail(`simulated delta for ${k} (${v}) is not an integer.`);
    }
    deltas[k] = amt;
  }

  const foldNative = (mint) => (mint && SOLANA_NATIVE_SOL_ALIASES.has(mint) ? SOL_SENTINEL : mint);
  const inputAsset = quote?.inputMint ? foldNative(quote.inputMint) : null;
  const outputAsset = quote?.outputMint ? foldNative(quote.outputMint) : null;
  if (!inputAsset || !outputAsset) {
    throw fail('quote is missing the input or output token address.');
  }
  if (inputAsset === outputAsset) {
    throw fail(`quote input and output tokens are the same (${inputAsset}); refusing to verify.`);
  }

  const inputIsNative = inputAsset === SOL_SENTINEL;

  // Bridges skip only assertion 2 (output arrival) below — see isBridgeRequest.
  const isBridge = isBridgeRequest(request);

  // --- Assertion 1: input outflow within the spend ceiling ---
  if (request.maxInputAmount == null) {
    throw fail('request has no maximum input to bound the outflow against.');
  }
  let cap;
  try {
    cap = BigInt(request.maxInputAmount);
  } catch {
    throw fail(`maximum input (${request.maxInputAmount}) is not an integer.`);
  }
  // Native-SOL input's lamport delta also carries the base fee, priority fee,
  // and net ATA rent (opened minus reclaimed), so it can't be bound at the
  // exact cap the way an SPL input can — but it must still be BOUNDED, not
  // skipped: without this, a transaction with an extra unaccounted native-SOL
  // outflow (e.g. a plain System-Program transfer, which assertSolanaInstructionsSafe
  // does not classify) sails through as long as the declared output still
  // arrives. The slack allows the worst realistic fee/rent noise — the same
  // priority-fee ceiling assertSolanaInstructionsSafe enforces, plus one
  // transient ATA's rent — without opening the cap back up to an unbounded drain.
  const effectiveCap = inputIsNative ? cap + NATIVE_FEE_RENT_SLACK_LAMPORTS : cap;
  const inputDelta = deltas[inputAsset] || 0n;
  const outflow = inputDelta < 0n ? -inputDelta : 0n;
  if (outflow > effectiveCap) {
    throw fail(`the input token (${inputAsset}) left the wallet by ${outflow}, exceeding your maximum input (${cap}${inputIsNative ? ` plus fee/rent slack` : ''}).`);
  }

  // --- Assertion 2: output arrives at or above the minimum acceptable ---
  // Skipped entirely for a bridge: the output settles on the destination
  // chain, so it can never appear in this source-chain simulation.
  if (!isBridge) {
    const swapMode = request.swapMode ?? 'exactIn';
    const outputIsNative = outputAsset === SOL_SENTINEL;
    const outputDelta = deltas[outputAsset] || 0n;
    let minOut;
    if (swapMode === 'exactOut') {
      if (request.amount == null) throw fail('exactOut request is missing the requested output amount.');
      try {
        minOut = BigInt(request.amount);
      } catch {
        throw fail(`requested output amount (${request.amount}) is not an integer.`);
      }
      if (minOut <= 0n) {
        throw fail(`exactOut request has a non-positive output amount (${minOut}); cannot compute a minimum acceptable output.`);
      }
    } else {
      const quotedRaw = quote?.outAmount ?? quote?.outputAmount;
      if (quotedRaw == null) {
        throw fail('quote is missing the quoted output amount; cannot compute the minimum acceptable output.');
      }
      let quoted;
      try {
        quoted = BigInt(quotedRaw);
      } catch {
        throw fail(`quoted output amount (${quotedRaw}) is not an integer.`);
      }
      if (quoted <= 0n) {
        throw fail(`quote has a non-positive output amount (${quoted}); cannot compute a minimum acceptable output.`);
      }
      // Floor of quoted × (1 − slippage), capped at 50% independent of what the
      // user set (mirrors assertSwapOutcome's rationale: a defence-in-depth
      // floor, not the user's execution tolerance).
      const rawSlip = Number.isFinite(slippage) && slippage >= 0 ? slippage : 0.03;
      const slip = Math.min(rawSlip, 0.5);
      const bps = BigInt(Math.min(10000, Math.round(slip * 10000)));
      minOut = (quoted * (10000n - bps)) / 10000n;
    }
    // Native-SOL output carries the same fee/rent noise as native input: the
    // lamport delta is (SOL received − base/priority fee − net ATA rent), so a
    // legitimate trade can land a few million lamports under the quoted amount at
    // tight slippage or on a congested-network priority fee. Relax the floor by
    // the same combined fee/rent slack used for native siblings (assertion 3) and
    // native input (assertion 1) so fee noise never false-blocks; the slippage
    // floor still bounds any real shortfall. SPL output has no such noise and
    // keeps the exact floor.
    const outputFloorSlack = outputIsNative
      ? (siblingDustThreshold != null ? siblingDustThreshold : NATIVE_FEE_RENT_SLACK_LAMPORTS)
      : 0n;
    // minOut can be smaller than the dust tolerance for a dust-quoted swap; clamp
    // the floor at 0 so the subtraction never goes negative and silently admits
    // any non-negative outputDelta (including zero). The explicit outputDelta <= 0n
    // check below then restores the invariant assertSwapOutcome (the EVM sibling)
    // gets for free because its minOut can never collapse to <= 0: a swap must
    // deliver SOME positive output, even when the dust-adjusted floor is 0.
    const adjustedFloor = minOut > outputFloorSlack ? minOut - outputFloorSlack : 0n;
    if (outputDelta <= 0n || outputDelta < adjustedFloor) {
      throw fail(`the output token (${outputAsset}) increased by only ${outputDelta}, below the minimum acceptable output (${minOut}).`);
    }
  }

  // --- Assertion 3: no other tracked asset leaves the wallet ---
  const nativeDust = siblingDustThreshold != null ? siblingDustThreshold : NATIVE_FEE_RENT_SLACK_LAMPORTS;
  for (const [token, delta] of Object.entries(deltas)) {
    if (token === inputAsset) continue; // bounded by assertion 1 (with fee/rent slack, for native input)
    if (delta >= 0n) continue;
    const dust = token === SOL_SENTINEL ? nativeDust : 0n;
    if (-delta > dust) {
      throw fail(`a token other than the one you are selling (${token}) left the wallet (delta ${delta}); a swap must not move any token except the input.`);
    }
  }

  // inputAssertionSkipped tells the caller assertion 1 ran with the fee/rent
  // slack applied (native-SOL input, per the JSDoc above), so it can surface
  // that instead of implying the input spend was tightly delta-verified.
  // outputAssertionSkipped tells the caller assertion 2 did not run at all
  // (cross-chain bridge, per the JSDoc above).
  return { verified: true, inputAssertionSkipped: inputIsNative, outputAssertionSkipped: isBridge };
}

/**
 * Statically inspect a Solana transaction's instructions for drain vectors a
 * balance-delta simulation can't see — granting a token delegate, changing a
 * token account's authority, or closing an account to a stranger — and for an
 * excessive compute-budget priority fee. Runs before signing, on the raw
 * instructions rather than trusting the aggregator's intent.
 *
 * Scope: this inspects only the recognized top-level instructions of the
 * message — the SPL Token and ComputeBudget programs. It does not, and by
 * design cannot, see instructions a program issues via CPI at runtime, nor
 * does it classify calls to programs it doesn't recognize. It is one layer
 * (paired with the intent-binding metadata check), not a complete
 * authorization audit of the transaction.
 *
 * IMPORTANT — this static check does NOT classify SPL Transfer/TransferChecked:
 * a legitimate swap or vault deposit moves the input token (and WSOL) with
 * exactly those instructions, so they can't be blanket-rejected, and there is
 * nothing here to bound their destination or amount. On its own this leaves a
 * residual gap: a transaction that also transfers an unrelated ("sibling")
 * token the wallet holds, authorized by the wallet, would pass this check.
 * That gap is now closed, for swap execution, by outcome simulation —
 * assertSolanaSwapOutcome, run via verifySolanaSwapOutcome immediately after
 * this check on all Solana swap-execute signing paths (trading.js), simulates
 * the transaction and rejects any balance delta on a token other than the
 * declared input/output. That simulation degrades gracefully (warns and
 * proceeds) when no simulation RPC endpoint is configured, so this static
 * check plus the metadata binding remain the ONLY transaction-level guards
 * whenever a sim RPC is unavailable. Limit-order vault deposit/cancel
 * (limit-order.js) call only this static check, not verifySolanaSwapOutcome —
 * they have no swap quote (no declared input/output pair) to bind an outcome
 * check against, so the sibling-transfer gap described above is still open
 * there; tracked as a follow-up, not covered here.
 *
 * Within that scope, the SPL Token program requires the *authority* of
 * Approve/ApproveChecked/SetAuthority/CloseAccount to sign the transaction,
 * so checking "does our wallet authorize this instruction" catches the drain
 * without an RPC-based account-ownership lookup. For a single-owner authority
 * the wallet sits in the authority position itself; for a multisig authority
 * the authority account is the multisig and our wallet appears among the
 * signer accounts that follow it — so we treat the wallet signing *anywhere
 * from the authority position onward* as authorizing the instruction.
 * Address-lookup-table-resolved accounts can never be signers, so those
 * positions are always statically resolvable; only CloseAccount's destination
 * can legitimately be ALT-resolved, and an unresolvable destination is treated
 * the same as a stranger (fail closed). The instruction's own program ID must
 * also be statically resolvable — an ALT-resolved program ID can't be checked
 * against SPL_TOKEN_PROGRAMS/COMPUTE_BUDGET_PROGRAM, so it's rejected outright
 * rather than silently skipped.
 *
 * Throws on any of those patterns. Returns the parsed transaction otherwise.
 */
export function assertSolanaInstructionsSafe(txBase64, { walletAddress } = {}) {
  // Fail closed on a missing wallet address: every authority check below
  // compares resolved accounts against `walletAddress`, so a null/undefined
  // address would make each comparison silently false and disable the drain
  // protection rather than over-reject. Refuse to run the check without knowing
  // whose signature we're guarding.
  if (!walletAddress) {
    throw new Error('Cannot verify Solana instruction safety without the signing wallet address. Refusing to sign.');
  }
  const parsed = parseTransactionMessage(txBase64);
  const accountAt = (ix, position) => resolveStaticAccount(parsed, ix.accountIndexes[position]);

  // Does our wallet authorize this SPL instruction? For a single-owner
  // authority the wallet is at `authorityPos`; for a multisig authority the
  // authority account is the multisig and our wallet is one of the signer
  // accounts that follow it. Scanning from `authorityPos` to the end covers
  // both. Returns true on an unresolvable authority (null): the authority must
  // be a signer, so it can never legitimately be ALT-resolved — a null means an
  // out-of-bounds or ALT index there, i.e. a crafted/malformed transaction, and
  // we fail closed rather than let a silent misparse pass.
  const walletAuthorizes = (ix, authorityPos) => {
    if (accountAt(ix, authorityPos) === null) return true;
    for (let i = authorityPos; i < ix.accountIndexes.length; i++) {
      if (accountAt(ix, i) === walletAddress) return true;
    }
    return false;
  };

  let computeUnitLimit = null;
  let computeUnitPriceMicroLamports = null;

  for (const ix of parsed.instructions) {
    const programId = resolveStaticAccount(parsed, ix.programIdIndex);
    // A program ID that's only ALT-resolvable can't be checked against
    // SPL_TOKEN_PROGRAMS/COMPUTE_BUDGET_PROGRAM without an RPC call this
    // static check intentionally doesn't make — and skipping it here would
    // let an Approve/SetAuthority/CloseAccount instruction bypass the drain
    // protection above just by routing the program ID through an ALT entry.
    // Real swap/vault transactions reference these well-known programs as
    // static keys, so fail closed rather than silently skip classification.
    if (!programId) {
      throw new Error(
        'Solana transaction invokes a program only resolvable via an address-lookup-table entry, which cannot be safety-classified. Refusing to sign.',
      );
    }

    if (SPL_TOKEN_PROGRAMS.has(programId)) {
      // No discriminator byte — not a valid SPL Token instruction (the runtime
      // would reject it too). Skip explicitly so the fail-closed intent doesn't
      // rest on `undefined` never equalling a discriminant constant.
      if (ix.data.length === 0) continue;
      const discriminator = ix.data[0];
      if (discriminator === SPL_APPROVE || discriminator === SPL_APPROVE_CHECKED) {
        if (walletAuthorizes(ix, discriminator === SPL_APPROVE_CHECKED ? 3 : 2)) {
          throw new Error(
            'Solana transaction grants a token delegate (Approve) authorized by your wallet. Refusing to sign.',
          );
        }
      } else if (discriminator === SPL_SET_AUTHORITY) {
        if (walletAuthorizes(ix, 1)) {
          throw new Error(
            "Solana transaction changes a token account's authority (SetAuthority) using your wallet's signature. Refusing to sign.",
          );
        }
      } else if (discriminator === SPL_CLOSE_ACCOUNT) {
        const authority = accountAt(ix, 2);
        const destination = accountAt(ix, 1);
        // Fail closed on an unresolvable authority regardless of destination;
        // otherwise reject only when our wallet authorizes the close and the
        // rent goes anywhere but back to us.
        if (authority === null || (walletAuthorizes(ix, 2) && destination !== walletAddress)) {
          throw new Error(
            `Solana transaction closes a token account and sends the reclaimed rent to ` +
            `${destination || 'an address only resolvable via an address lookup table'} instead of your wallet. Refusing to sign.`,
          );
        }
      }
    } else if (programId === COMPUTE_BUDGET_PROGRAM) {
      if (ix.data.length === 0) continue; // no discriminator — not a valid ComputeBudget instruction
      const discriminator = ix.data[0];
      if (discriminator === COMPUTE_BUDGET_SET_UNIT_LIMIT && ix.data.length >= 5) {
        computeUnitLimit = ix.data.readUInt32LE(1);
      } else if (discriminator === COMPUTE_BUDGET_SET_UNIT_PRICE) {
        if (ix.data.length < 9) {
          throw new Error('Solana transaction has a malformed compute-budget price instruction. Refusing to sign.');
        }
        computeUnitPriceMicroLamports = ix.data.readBigUInt64LE(1);
      }
    }
  }

  if (computeUnitPriceMicroLamports != null) {
    const units = BigInt(computeUnitLimit ?? SOLANA_MAX_COMPUTE_UNITS);
    const feeLamports = (computeUnitPriceMicroLamports * units) / 1_000_000n;
    if (feeLamports > MAX_PRIORITY_FEE_LAMPORTS) {
      throw new Error(
        `Solana transaction sets an excessive priority fee (~${feeLamports} lamports, cap ${MAX_PRIORITY_FEE_LAMPORTS}). Refusing to sign.`,
      );
    }
  }

  return parsed;
}
