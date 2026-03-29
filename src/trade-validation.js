/**
 * Trade input validation for the Nansen CLI.
 * Catches common agent errors (wrong addresses, same-token swaps,
 * bad amounts) before any network call.
 */

import { validateAddress } from './api.js';
import { CHAIN_RPCS } from './rpc-urls.js';

const SUPPORTED_CHAINS = ['solana', 'base'];

/**
 * Validate quote inputs before any network call.
 * Throws on validation failure with an actionable error message.
 */
export function validateQuoteInput({ chain, from, to, amount }) {
  // 1. Chain must be supported
  const normalizedChain = chain?.toLowerCase();
  if (!SUPPORTED_CHAINS.includes(normalizedChain)) {
    throw new Error(
      `Unsupported chain "${chain}". Supported chains: ${SUPPORTED_CHAINS.join(', ')}.`
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
  const toResult = validateAddress(to, normalizedChain);
  if (!toResult.valid) {
    throw new Error(
      `Invalid buy token address for ${normalizedChain}. ${toResult.error}`
    );
  }

  // 4. Sell and buy token must be different
  const fromNorm = normalizedChain === 'solana' ? from : from.toLowerCase();
  const toNorm = normalizedChain === 'solana' ? to : to.toLowerCase();
  if (fromNorm === toNorm) {
    throw new Error(
      `Cannot swap ${from} for itself. Sell and buy tokens must be different.`
    );
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

// Native token symbols for error messages.
const NATIVE_SYMBOLS = { solana: 'SOL', base: 'ETH' };

const FEE_BUFFER = { solana: 0.005, base: 0.00004 };
const HIGH_PERCENTAGE_THRESHOLD = 95;
const AUTO_ADJUST_THRESHOLD_PERCENT = 2;

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
