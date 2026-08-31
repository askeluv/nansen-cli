/**
 * x402 Auto-Payment via WalletConnect
 *
 * Handles automatic payment signing when the API returns HTTP 402.
 * Uses the walletconnect CLI to check wallet connection and sign EIP-712 typed data.
 */

import crypto from 'crypto';
import { NansenError, ErrorCode } from './api.js';
import { wcExec } from './walletconnect-exec.js';
import { EVM_CHAIN_IDS } from './chain-ids.js';
import { evaluatePaymentRequirement } from './x402-policy.js';

/**
 * Check if a WalletConnect wallet session is active.
 * Returns { wallet, accounts, expires } or null.
 */
export async function checkWalletConnection() {
  try {
    const output = await wcExec('walletconnect', ['whoami', '--json'], 3000);
    const data = JSON.parse(output);
    if (data.connected === false) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Select a compatible payment requirement from the accepts array.
 * Requires scheme=exact and EIP-3009 TransferWithAuthorization support (extra.name + extra.version).
 */
export function selectPaymentRequirement(accepts) {
  if (!Array.isArray(accepts) || accepts.length === 0) return null;

  return accepts.find(req =>
    req.scheme === 'exact' &&
    req.extra?.name &&
    req.extra?.version
  ) || null;
}

/**
 * Parse chain ID from network string (e.g., "eip155:8453" → 8453)
 */
function parseChainId(network) {
  if (!network) return null;
  const match = network.match(/^eip155:(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Build EIP-712 typed data for TransferWithAuthorization (EIP-3009).
 */
export function buildEIP712TypedData({ fromAddress, requirement }) {
  const { asset, payTo, extra, maxTimeoutSeconds } = requirement;
  // x402 uses "amount", fall back to "maxAmountRequired" for compatibility
  const amount = requirement.amount || requirement.maxAmountRequired;

  // Determine chain ID: extra.chainId > parsed from network > fallback map > base
  const chainId = extra.chainId || parseChainId(requirement.network) || EVM_CHAIN_IDS[requirement.chain] || EVM_CHAIN_IDS.base;

  const now = Math.floor(Date.now() / 1000);
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    domain: {
      name: extra.name,
      version: extra.version,
      chainId,
      verifyingContract: asset,
    },
    message: {
      from: fromAddress,
      to: payTo,
      value: amount,
      validAfter: now - 600, // 10 min in the past to tolerate clock skew between client and verifier
      validBefore: now + (maxTimeoutSeconds || 120),
      nonce,
    },
  };

  return typedData;
}

/**
 * Build the base64-encoded Payment-Signature header value.
 * Follows x402 v2 spec: { x402Version, resource, accepted, payload }
 */
export function buildPaymentSignatureHeader({ signature, authorization, resource, accepted }) {
  const paymentPayload = {
    x402Version: 2,
    resource: resource || { url: '', description: '', mimeType: '' },
    accepted: accepted || {},
    payload: {
      signature,
      authorization,
    },
  };
  return Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64');
}

/**
 * Format amount for human-readable display (e.g., "0.01 USDC")
 */
function formatPaymentAmount(requirement) {
  const { extra } = requirement;
  const rawAmount = requirement.amount || requirement.maxAmountRequired;
  const symbol = extra.symbol || extra.name || 'tokens';
  const decimals = extra.decimals || 6;
  const amount = Number(rawAmount) / Math.pow(10, decimals);
  const chain = requirement.network || requirement.chain || 'unknown';
  return `${amount} ${symbol} on ${chain}`;
}

/**
 * Handle x402 payment: check wallet, sign, return Payment-Signature header.
 *
 * @param {Object} paymentRequirements - Decoded payment requirements from 402 response
 * @param {string} requestUrl - The original request URL (for context in errors)
 * @returns {string} Base64-encoded Payment-Signature header value
 * @throws {NansenError} On failure
 */
export async function handleX402Payment(paymentRequirements) {
  // 1. Check wallet connection
  const wallet = await checkWalletConnection();
  if (!wallet) {
    throw new NansenError(
      'x402 payment required but no wallet connected. ' +
        'To pay automatically: create a local wallet with `nansen wallet create` (then set NANSEN_WALLET_PASSWORD), ' +
        'or connect an external wallet via the `walletconnect` CLI (`walletconnect connect`).',
      ErrorCode.PAYMENT_REQUIRED,
      402
    );
  }

  const fromAddress = wallet.accounts[0]?.address;
  if (!fromAddress) {
    throw new NansenError(
      'x402 payment required but wallet has no accounts.',
      ErrorCode.PAYMENT_REQUIRED,
      402
    );
  }

  // 2. Select compatible payment requirement
  const accepts = paymentRequirements.accepts || paymentRequirements;
  const requirement = selectPaymentRequirement(Array.isArray(accepts) ? accepts : [accepts]);
  if (!requirement) {
    const available = (Array.isArray(accepts) ? accepts : []).map(r => r.scheme).join(', ');
    throw new NansenError(
      `x402 payment required but no compatible payment method found. Available: ${available || 'none'}. Need scheme=exact with EIP-3009 support.`,
      ErrorCode.PAYMENT_REQUIRED,
      402
    );
  }

  // 3. Evaluate payment policy before touching any signing material
  const decision = evaluatePaymentRequirement(requirement);
  if (!decision.ok) {
    throw new Error(decision.reason);
  }

  // 4. Build EIP-712 typed data
  const typedData = buildEIP712TypedData({ fromAddress, requirement });
  const typedDataJson = JSON.stringify(typedData);

  // 5. Log payment info to stderr (stdout is for JSON output)
  const amountStr = formatPaymentAmount(requirement);
  process.stderr.write(`x402: Requesting payment approval (${amountStr})...\n`);

  // 6. Sign via walletconnect CLI (120s timeout for user approval)
  let signResult;
  try {
    const output = await wcExec('walletconnect', ['sign-typed-data', typedDataJson], 120000);
    // walletconnect may print status messages before the JSON line — extract JSON only
    const jsonLine = output.split('\n').find(line => line.startsWith('{'));
    if (!jsonLine) throw new Error('No JSON output from walletconnect sign-typed-data');
    signResult = JSON.parse(jsonLine);
  } catch (err) {
    throw new NansenError(
      `x402 payment signing failed: ${err.message}`,
      ErrorCode.PAYMENT_REQUIRED,
      402
    );
  }

  // 7. Build Payment-Signature header (authorization values must be strings per x402 spec)
  const authorization = {
    from: fromAddress,
    to: requirement.payTo,
    value: (requirement.amount || requirement.maxAmountRequired).toString(),
    validAfter: typedData.message.validAfter.toString(),
    validBefore: typedData.message.validBefore.toString(),
    nonce: typedData.message.nonce,
  };

  const headerValue = buildPaymentSignatureHeader({
    signature: signResult.signature,
    authorization,
    resource: paymentRequirements.resource || { url: '', description: '', mimeType: '' },
    accepted: requirement,
  });

  process.stderr.write(`x402: Payment signed successfully.\n`);
  return headerValue;
}
