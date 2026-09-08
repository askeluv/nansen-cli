/**
 * x402 Auto-Payment via WalletConnect
 *
 * Handles automatic payment signing when the API returns HTTP 402.
 * Uses the walletconnect CLI to check wallet connection and sign EIP-712 typed data.
 */

import crypto from 'crypto';
import { NansenError, ErrorCode } from './api.js';
import { wcExec } from './walletconnect-exec.js';
import { evaluatePaymentRequirement, resolvePaymentAmount, resolvePayTo } from './x402-policy.js';

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
  const payTo = resolvePayTo(requirement);
  const { asset, maxTimeoutSeconds } = requirement;
  const extra = requirement.extra || {};
  const amount = resolvePaymentAmount(requirement);

  if (!extra.name || !extra.version) {
    throw new Error(
      'Refusing to sign x402 payment: EIP-712 domain name/version missing from requirement.extra.',
    );
  }

  // Chain id comes only from the CAIP-2 network the policy validated — not from
  // a remote extra.chainId override, which could change the signing domain.
  const chainId = parseChainId(requirement.network);
  if (chainId === null) {
    throw new Error(
      `Refusing to sign x402 payment: unsupported or missing EVM network ${requirement.network}.`,
    );
  }
  // A remote extra.chainId that disagrees with the network is a domain-binding
  // mismatch — refuse rather than sign under either interpretation. A null or
  // empty extra.chainId means "unspecified", not a conflict, so treat it as absent.
  if (extra.chainId != null && extra.chainId !== '' && Number(extra.chainId) !== chainId) {
    throw new Error(
      `Refusing to sign x402 payment: extra.chainId ${extra.chainId} conflicts with ` +
      `network ${requirement.network} (chain id ${chainId}).`,
    );
  }

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
  const rawAmount = resolvePaymentAmount(requirement);
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
    to: resolvePayTo(requirement),
    value: resolvePaymentAmount(requirement).toString(),
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
