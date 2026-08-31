/**
 * Nansen CLI - x402 EVM Auto-Payment
 * Implements EIP-3009 TransferWithAuthorization via EIP-712 typed data signing.
 * Zero external dependencies — uses Node.js built-in crypto + wallet.js keccak256.
 */

import crypto from 'crypto';
import { keccak256, signSecp256k1 } from './crypto.js';

// ============= EIP-712 Type Hashing =============

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const AUTHORIZATION_TYPES = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

// ============= Permit2 (permit2-exact transfer method) =============
// Some tokens (e.g. USDT/USDC on BNB Smart Chain) predate EIP-3009, so
// facilitators settle them through Uniswap's canonical Permit2 contract
// instead: the payer signs a PermitWitnessTransferFrom and the facilitator's
// proxy (requirements.extra.spenderAddress) executes the transfer. Requires a
// one-time on-chain `token.approve(PERMIT2_ADDRESS, ...)` from the payer.

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Permit2's EIP-712 domain has no version field.
const PERMIT2_DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const TOKEN_PERMISSIONS_TYPES = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
];

const WITNESS_TYPES = [
  { name: 'to', type: 'address' },
  { name: 'validAfter', type: 'uint256' },
];

// encodeType for a nested primary type: referenced struct types are appended
// in alphabetical order per EIP-712 (TokenPermissions before Witness).
const PERMIT_WITNESS_TYPE_STRING =
  'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)' +
  'TokenPermissions(address token,uint256 amount)' +
  'Witness(address to,uint256 validAfter)';

/**
 * Encode a type string for EIP-712 typeHash.
 * e.g. "TransferWithAuthorization(address from,address to,uint256 value,...)"
 */
function encodeType(typeName, fields) {
  const fieldStrs = fields.map(f => `${f.type} ${f.name}`);
  return `${typeName}(${fieldStrs.join(',')})`;
}

/**
 * Compute typeHash = keccak256(encodeType(...))
 */
function typeHash(typeName, fields) {
  return keccak256(Buffer.from(encodeType(typeName, fields), 'utf8'));
}

/**
 * ABI-encode a single value to 32 bytes based on its EIP-712 type.
 */
function encodeValue(fieldType, value) {
  if (fieldType === 'string') {
    // Strings are hashed
    return keccak256(Buffer.from(value, 'utf8'));
  }
  if (fieldType === 'bytes') {
    const buf = typeof value === 'string' ? Buffer.from(value.replace(/^0x/, ''), 'hex') : value;
    return keccak256(buf);
  }
  if (fieldType === 'bytes32') {
    if (typeof value === 'string') {
      return Buffer.from(value.replace(/^0x/, ''), 'hex');
    }
    return value;
  }
  if (fieldType === 'address') {
    // Left-pad address to 32 bytes
    const addr = value.replace(/^0x/, '').toLowerCase();
    return Buffer.from(addr.padStart(64, '0'), 'hex');
  }
  if (fieldType.startsWith('uint') || fieldType.startsWith('int')) {
    // Encode as 32-byte big-endian
    const hex = BigInt(value).toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
  }
  if (fieldType === 'bool') {
    return Buffer.from((value ? '1' : '0').padStart(64, '0'), 'hex');
  }
  throw new Error(`Unsupported EIP-712 field type: ${fieldType}`);
}

/**
 * Compute struct hash = keccak256(typeHash || encodeValue(field1) || encodeValue(field2) || ...)
 */
function hashStruct(typeName, fields, data) {
  const parts = [typeHash(typeName, fields)];
  for (const field of fields) {
    const value = data[field.name];
    if (value === undefined || value === null) {
      throw new Error(`Missing EIP-712 field: ${field.name}`);
    }
    parts.push(encodeValue(field.type, value));
  }
  return keccak256(Buffer.concat(parts));
}

/**
 * Compute EIP-712 domain separator hash.
 */
function hashDomain(domain) {
  return hashStruct('EIP712Domain', DOMAIN_TYPES, domain);
}

/**
 * Compute EIP-712 final hash: keccak256("\x19\x01" || domainSeparator || structHash)
 */
export function hashTypedData(domain, primaryType, fields, message) {
  const domainSeparator = hashDomain(domain);
  const structHash = hashStruct(primaryType, fields, message);
  return keccak256(Buffer.concat([
    Buffer.from([0x19, 0x01]),
    domainSeparator,
    structHash,
  ]));
}

/**
 * Compute the EIP-712 digest for a Permit2 PermitWitnessTransferFrom.
 *
 * Hand-rolled because the generic helpers above only support flat structs:
 * the primary typeHash must cover the full type string including referenced
 * structs, and struct-typed fields encode as their structHash.
 *
 * @param {number} chainId - EVM chain id (Permit2 domain field)
 * @param {object} message - { permitted: {token, amount}, spender, nonce, deadline, witness: {to, validAfter} }
 * @returns {Buffer} 32-byte digest to sign
 */
export function hashPermit2WitnessTransfer(chainId, message) {
  const domainSeparator = hashStruct('EIP712Domain', PERMIT2_DOMAIN_TYPES, {
    name: 'Permit2',
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  });
  const structHash = keccak256(Buffer.concat([
    keccak256(Buffer.from(PERMIT_WITNESS_TYPE_STRING, 'utf8')),
    hashStruct('TokenPermissions', TOKEN_PERMISSIONS_TYPES, message.permitted),
    encodeValue('address', message.spender),
    encodeValue('uint256', message.nonce),
    encodeValue('uint256', message.deadline),
    hashStruct('Witness', WITNESS_TYPES, message.witness),
  ]));
  return keccak256(Buffer.concat([
    Buffer.from([0x19, 0x01]),
    domainSeparator,
    structHash,
  ]));
}

// ============= x402 EVM Payment =============

/**
 * Extract chain ID from CAIP-2 network identifier.
 * e.g. "eip155:8453" → 8453
 */
function getChainId(network) {
  const match = network.match(/^eip155:(\d+)$/);
  if (!match) throw new Error(`Invalid EVM network: ${network}`);
  return parseInt(match[1], 10);
}

/**
 * Create an x402 payment payload for EVM.
 *
 * Routes on requirements.extra.assetTransferMethod: absent or "eip3009" signs
 * an EIP-3009 TransferWithAuthorization (gasless); "permit2-exact" signs a
 * Permit2 PermitWitnessTransferFrom (requires a prior one-time
 * token.approve(PERMIT2_ADDRESS, ...)). Other methods throw so the fallback
 * loop tries the next accepts entry.
 *
 * @param {object} requirements - Parsed PaymentRequirements from 402 response
 * @param {string} privateKeyHex - 32-byte EVM private key as hex
 * @param {string} walletAddress - Signer's EVM address
 * @param {string} resource - Original request URL
 * @returns {string} Base64-encoded PaymentPayload for Payment-Signature header
 */
export function createEvmPaymentPayload(requirements, privateKeyHex, walletAddress, resource) {
  const chainId = getChainId(requirements.network);
  const extra = requirements.extra || {};

  const method = extra.assetTransferMethod;
  if (method === 'permit2-exact') {
    return createPermit2ExactPayload(requirements, privateKeyHex, walletAddress, resource);
  }
  if (method && method !== 'eip3009') {
    throw new Error(`Unsupported assetTransferMethod: ${method}`);
  }

  // Token name and version from requirements.extra (set by server/facilitator)
  const tokenName = extra.name;
  const tokenVersion = extra.version || '1';

  if (!tokenName) {
    throw new Error('EIP-712 domain name missing from requirements.extra');
  }

  // Generate random nonce (32 bytes)
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');

  // Validity window: valid now, expires in 1 hour
  const now = Math.floor(Date.now() / 1000);
  const validAfter = '0';
  const validBefore = String(now + 3600);

  // EIP-712 domain
  const domain = {
    name: tokenName,
    version: tokenVersion,
    chainId,
    verifyingContract: requirements.asset,
  };

  // EIP-3009 message
  const message = {
    from: walletAddress,
    to: requirements.payTo ?? requirements.pay_to,
    value: BigInt(requirements.amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce,
  };

  // Hash and sign
  const msgHash = hashTypedData(domain, 'TransferWithAuthorization', AUTHORIZATION_TYPES, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  const signature = '0x' + r.toString('hex') + s.toString('hex') + (27 + v).toString(16);

  // Build payload (camelCase keys per x402 spec)
  const payload = {
    x402Version: 2,
    payload: {
      authorization: {
        from: walletAddress,
        to: message.to,
        value: String(requirements.amount),
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: nonce,
      },
      signature: signature,
    },
    accepted: requirements,
  };

  // Add resource as object if provided
  if (resource) {
    payload.resource = { url: resource };
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Create an x402 payment payload via Permit2 PermitWitnessTransferFrom
 * (assetTransferMethod "permit2-exact").
 *
 * The spender is the facilitator's Permit2 proxy advertised in
 * requirements.extra.spenderAddress; the witness binds the transfer to the
 * merchant wallet (requirements.payTo). Wire-format numeric fields are
 * decimal strings.
 *
 * @param {object} requirements - Parsed PaymentRequirements from 402 response
 * @param {string} privateKeyHex - 32-byte EVM private key as hex
 * @param {string} walletAddress - Signer's EVM address
 * @param {string} resource - Original request URL
 * @returns {string} Base64-encoded PaymentPayload for Payment-Signature header
 */
export function createPermit2ExactPayload(requirements, privateKeyHex, walletAddress, resource) {
  const chainId = getChainId(requirements.network);
  const extra = requirements.extra || {};
  const spender = extra.spenderAddress;
  if (!spender) {
    throw new Error('spenderAddress missing from requirements.extra (required for permit2-exact)');
  }

  const payTo = requirements.payTo ?? requirements.pay_to;
  const now = Math.floor(Date.now() / 1000);
  // 256-bit random nonce — Permit2 uses an unordered nonce bitmap.
  const nonce = BigInt('0x' + crypto.randomBytes(32).toString('hex')).toString();
  const deadline = String(now + 3600);
  const validAfter = String(now - 60); // allow clock skew

  const message = {
    permitted: { token: requirements.asset, amount: BigInt(requirements.amount) },
    spender,
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
    witness: { to: payTo, validAfter: BigInt(validAfter) },
  };

  const msgHash = hashPermit2WitnessTransfer(chainId, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  const signature = '0x' + r.toString('hex') + s.toString('hex') + (27 + v).toString(16);

  const payload = {
    x402Version: 2,
    payload: {
      permit2Authorization: {
        permitted: { token: requirements.asset, amount: String(requirements.amount) },
        from: walletAddress,
        spender,
        nonce,
        deadline,
        witness: { to: payTo, validAfter },
      },
      signature,
    },
    accepted: requirements,
  };

  if (resource) {
    payload.resource = { url: resource };
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Check if a network string is an EVM network.
 */
export function isEvmNetwork(network) {
  return typeof network === 'string' && network.startsWith('eip155:');
}
