/**
 * nansen bridge — Hyperliquid bridge commands (EVM <-> Hyperliquid via Relay).
 *
 * Calls nansen-api /api/v1/bridge/* endpoints. Transaction signing and
 * EVM broadcasting happen client-side; HL withdrawal signatures are
 * proxied through the API's /bridge/execute endpoint.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { signSecp256k1 } from './crypto.js';
import { retrievePassword } from './keychain.js';
import {
  evmRpcCall,
  getEvmNonce,
  getQuotesDir,
  safeQuotesPath,
  signEvmTransaction,
  waitForReceipt,
} from './trading.js';
import { exportWallet, getWalletConfig, showWallet } from './wallet.js';
import { hashTypedData } from './x402-evm.js';

const QUOTE_TTL_MS = 3600000; // 1 hour

const BRIDGE_TOKENS = {
  ethereum:    { USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  base:        { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  arbitrum:    { USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  polygon:     { USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
  bnb:         { USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
  hyperliquid: { USDC: '0x00000000000000000000000000000000' },
};

const BRIDGE_CHAINS = new Set([
  'ethereum', 'base', 'arbitrum', 'polygon', 'bnb', 'hyperliquid',
]);

function resolveBridgeToken(symbolOrAddress, chain) {
  if (!symbolOrAddress || !chain) return symbolOrAddress;
  const tokens = BRIDGE_TOKENS[chain.toLowerCase()];
  if (!tokens) return symbolOrAddress;
  return tokens[symbolOrAddress.toUpperCase()] || symbolOrAddress;
}

// ── API helpers ──────────────────────────────────────────────────────

async function getBridgeQuote(apiInstance, params) {
  return apiInstance.request('/api/v1/bridge/quote', params);
}

async function postBridgeExecute(apiInstance, targetUrl, body) {
  return apiInstance.request('/api/v1/bridge/execute', { target_url: targetUrl, body });
}

async function getBridgeStatus(apiInstance, { requestId, txHash }) {
  const params = new URLSearchParams();
  if (requestId) params.set('request_id', requestId);
  if (txHash) params.set('tx_hash', txHash);
  return apiInstance.request(`/api/v1/bridge/status?${params}`, {}, { method: 'GET' });
}

// ── Quote caching ────────────────────────────────────────────────────

function saveBridgeQuote(response, originChain, destinationChain, walletProvider, walletAddress) {
  const dir = getQuotesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.randomBytes(4).toString('hex');
  const quoteId = `bridge-${Date.now()}-${hash}`;
  const data = {
    quoteId,
    type: 'bridge',
    originChain,
    destinationChain,
    walletProvider,
    walletAddress,
    timestamp: Date.now(),
    response,
  };
  const filePath = path.join(dir, `${quoteId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  return quoteId;
}

function loadBridgeQuote(quoteId) {
  const filePath = safeQuotesPath(`${quoteId}.json`);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Bridge quote "${quoteId}" not found. Quotes expire after 1 hour.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Date.now() - data.timestamp > QUOTE_TTL_MS) {
    fs.unlinkSync(filePath);
    throw new Error('Bridge quote has expired. Please request a new quote.');
  }
  return data;
}

// ── EIP-712 signing (for HL withdrawals) ─────────────────────────────

function signEip712Local(typedData, privateKeyHex) {
  const { domain, types, primaryType, message } = typedData;
  const fields = (types[primaryType] || []).map(f => ({ name: f.name, type: f.type }));
  const msgHash = hashTypedData(domain, primaryType, fields, message);
  const { r, s, v } = signSecp256k1(msgHash, Buffer.from(privateKeyHex, 'hex'));
  return '0x' + r.toString('hex') + s.toString('hex') + (27 + v).toString(16).padStart(2, '0');
}

// ── Step processors ──────────────────────────────────────────────────

async function processEvmStep(step, { chain, privateKeyHex, log }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const txData = item.data;

    const gasPrice = await evmRpcCall(chain, 'eth_gasPrice');
    const nonce = await getEvmNonce(chain, txData.from);

    const signedTx = signEvmTransaction(
      { ...txData, gasPrice },
      privateKeyHex,
      chain,
      parseInt(nonce, 16),
    );

    log(`  Broadcasting ${step.id} on ${chain}...`);
    const txHash = await evmRpcCall(chain, 'eth_sendRawTransaction', [signedTx]);
    log(`  Tx: ${txHash}`);

    const receipt = await waitForReceipt(chain, txHash);
    const status = parseInt(receipt.status, 16);
    if (status !== 1) {
      throw new Error(`Transaction reverted: ${txHash}`);
    }
    log(`  Confirmed in block ${parseInt(receipt.blockNumber, 16)}`);
  }
}

async function processSignatureStepLocal(step, { privateKeyHex, log, apiInstance }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const { data: signData } = item;

    if (signData.sign) {
      const typedData = {
        domain: signData.sign.domain,
        types: signData.sign.types,
        primaryType: signData.sign.primaryType,
        message: signData.sign.value,
      };
      const signature = signEip712Local(typedData, privateKeyHex);

      let targetUrl = signData.post.endpoint;
      if (!targetUrl.startsWith('http')) {
        targetUrl = `https://api.relay.link${targetUrl}`;
      }
      const postBody = { ...signData.post.body };

      if (targetUrl.includes('/authorize')) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${sep}signature=${signature}`;
      } else {
        postBody.signature = signature;
      }

      log(`  Signing ${step.id} (EIP-712)...`);
      await postBridgeExecute(apiInstance, targetUrl, postBody);
      log(`  Submitted to ${new URL(targetUrl).hostname}`);
    } else if (signData.action) {
      const domain = {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: 1,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      };
      const types = signData.eip712Types || {};
      const primaryType = signData.eip712PrimaryType || 'HyperliquidTransaction';
      const message = {
        ...(signData.action.parameters || signData.action),
        type: signData.action.type,
        signatureChainId: '0x1',
      };

      const typedData = { domain, types, primaryType, message };
      const signature = signEip712Local(typedData, privateKeyHex);
      const [rHex, sHex, vHex] = [signature.slice(2, 66), signature.slice(66, 130), signature.slice(130, 132)];

      const flatAction = { type: signData.action.type, ...signData.action.parameters, signatureChainId: '0x1' };
      const hlBody = {
        action: flatAction,
        nonce: signData.nonce,
        signature: { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) },
        vaultAddress: null,
      };

      log(`  Signing ${step.id} (Hyperliquid deposit)...`);
      await postBridgeExecute(apiInstance, 'https://api.hyperliquid.xyz/exchange', hlBody);
      log(`  Submitted to api.hyperliquid.xyz`);
    }
  }
}

async function processSignatureStepPrivy(step, { privyClient, walletId, log, apiInstance }) {
  for (const item of step.items || []) {
    if (item.status === 'complete') continue;
    const { data: signData } = item;

    let typedData;
    if (signData.sign) {
      typedData = {
        domain: signData.sign.domain,
        types: signData.sign.types,
        primaryType: signData.sign.primaryType,
        message: signData.sign.value,
      };
    } else if (signData.action) {
      typedData = {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 1,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: signData.eip712Types || {},
        primaryType: signData.eip712PrimaryType || 'HyperliquidTransaction',
        message: {
          ...(signData.action.parameters || signData.action),
          type: signData.action.type,
          signatureChainId: '0x1',
        },
      };
    } else {
      throw new Error(`Unexpected signature step format for ${step.id}`);
    }

    log(`  Signing ${step.id} via Privy...`);
    const result = await privyClient.ethSignTypedDataV4(walletId, typedData);
    const signature = result.data?.signature || result.signature || result;

    if (signData.sign) {
      let targetUrl = signData.post.endpoint;
      if (!targetUrl.startsWith('http')) targetUrl = `https://api.relay.link${targetUrl}`;
      const postBody = { ...signData.post.body };
      if (targetUrl.includes('/authorize')) {
        const sep = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${sep}signature=${signature}`;
      } else {
        postBody.signature = signature;
      }
      await postBridgeExecute(apiInstance, targetUrl, postBody);
    } else {
      const [rHex, sHex, vHex] = [signature.slice(2, 66), signature.slice(66, 130), signature.slice(130, 132)];
      const flatAction = { type: signData.action.type, ...signData.action.parameters, signatureChainId: '0x1' };
      const hlBody = {
        action: flatAction,
        nonce: signData.nonce,
        signature: { r: '0x' + rHex, s: '0x' + sHex, v: parseInt(vHex, 16) },
        vaultAddress: null,
      };
      await postBridgeExecute(apiInstance, 'https://api.hyperliquid.xyz/exchange', hlBody);
    }
    log(`  Submitted`);
  }
}

// ── Status polling ───────────────────────────────────────────────────

async function pollBridgeCompletion(apiInstance, { requestId, txHash, timeoutMs = 600000, pollMs = 10000, log = console.log }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await getBridgeStatus(apiInstance, { requestId, txHash });
      log(`  Bridge: ${status.status} (${status.raw_status || ''})`);
      if (status.status === 'success') return status;
      if (status.status === 'failure') {
        throw Object.assign(new Error('Bridge failed'), { code: 'BRIDGE_FAILED', details: status });
      }
      if (status.status === 'refund') {
        log('  Bridge: REFUNDED — funds returned on source chain');
        return status;
      }
    } catch (err) {
      if (err.code === 'BRIDGE_FAILED') throw err;
      log(`  Bridge: poll error — retrying...`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw Object.assign(
    new Error(`Bridge polling timed out after ${timeoutMs / 1000}s. Check manually: nansen bridge status --request-id ${requestId || txHash}`),
    { code: 'BRIDGE_TIMEOUT' },
  );
}

// ── Wallet helpers ───────────────────────────────────────────────────

function resolveWalletAddress(walletName) {
  let wallet;
  if (walletName) {
    wallet = showWallet(walletName);
  } else {
    const config = getWalletConfig();
    if (config.defaultWallet) wallet = showWallet(config.defaultWallet);
  }
  if (!wallet) throw new Error('No wallet found. Create one with: nansen wallet create');
  return {
    address: wallet.evm,
    provider: wallet.provider || 'local',
    privyWalletIds: wallet.privyWalletIds || null,
  };
}

function resolveWalletCredentials(walletName) {
  const config = getWalletConfig();
  const isPrivy = (() => {
    try {
      const w = showWallet(walletName || config.defaultWallet);
      return w.provider === 'privy';
    } catch { return false; }
  })();

  if (isPrivy) {
    return { provider: 'privy', privateKey: null };
  }

  let password = null;
  if (config.passwordHash) {
    const { password: pw, source } = retrievePassword();
    if (source === 'file') {
      process.stderr.write(
        '⚠️  Password loaded from ~/.nansen/wallets/.credentials (insecure).\n',
      );
    }
    password = pw;
  }

  const name = walletName || config.defaultWallet;
  if (!name) throw new Error('No wallet found. Create one with: nansen wallet create');
  const exported = exportWallet(name, password);
  return { provider: 'local', privateKey: exported.evm.privateKey };
}

// ── Command builder ──────────────────────────────────────────────────

export function buildBridgeCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'quote': async (args, apiInstance, flags, options) => {
      const originChain = (options['from-chain'] || options.from || '').toLowerCase();
      const destinationChain = (options['to-chain'] || options.to || '').toLowerCase();
      const fromTokenRaw = options['from-token'] || options.token || '';
      const toTokenRaw = options['to-token'] || '';
      const amount = options.amount;
      const slippageBps = options.slippage ? parseInt(options.slippage, 10) : 50;
      const walletName = options.wallet;
      const recipient = options.recipient;

      if (!originChain || !destinationChain || !fromTokenRaw || !amount) {
        throw new Error(
          `Usage: nansen bridge quote --from-chain <chain> --to-chain <chain> --from-token <token> --amount <baseUnits> [--wallet <name>]

OPTIONS:
  --from-chain    Source chain (${[...BRIDGE_CHAINS].join(', ')})
  --to-chain      Destination chain
  --from-token    Source token (symbol like USDC, or address)
  --to-token      Destination token (defaults to USDC)
  --amount        Amount in base units (integer string)
  --slippage      Slippage in bps (default 50 = 0.5%)
  --wallet        Wallet name
  --recipient     Destination wallet (defaults to same address)`,
        );
      }

      if (!BRIDGE_CHAINS.has(originChain)) {
        throw new Error(`Unsupported origin chain: ${originChain}. Supported: ${[...BRIDGE_CHAINS].join(', ')}`);
      }
      if (!BRIDGE_CHAINS.has(destinationChain)) {
        throw new Error(`Unsupported destination chain: ${destinationChain}. Supported: ${[...BRIDGE_CHAINS].join(', ')}`);
      }

      const originToken = resolveBridgeToken(fromTokenRaw, originChain);
      const destinationToken = toTokenRaw
        ? resolveBridgeToken(toTokenRaw, destinationChain)
        : resolveBridgeToken('USDC', destinationChain);

      const wallet = resolveWalletAddress(walletName);

      log(`\n  Fetching bridge quote: ${originChain} → ${destinationChain}...`);

      const result = await getBridgeQuote(apiInstance, {
        wallet_address: wallet.address,
        origin_chain: originChain,
        destination_chain: destinationChain,
        origin_token: originToken,
        destination_token: destinationToken,
        amount,
        slippage_bps: slippageBps,
        ...(recipient && { recipient }),
      });

      const details = result.details || {};
      const currIn = details.currencyIn || {};
      const currOut = details.currencyOut || {};
      const fees = result.fees || {};
      const relayerFee = fees.relayer || {};

      log(`\n  Bridge Quote: ${originChain} → ${destinationChain}`);
      log(`  Type:    ${result.execution_type}`);
      log(`  Send:    ${currIn.amountFormatted || amount} ${currIn.currency?.symbol || originToken}`);
      log(`  Receive: ${currOut.amountFormatted || '?'} ${currOut.currency?.symbol || destinationToken}`);
      if (relayerFee.amountUsd) {
        log(`  Fee:     $${relayerFee.amountUsd}`);
      }
      log(`  Steps:   ${(result.steps || []).length}`);
      for (const s of result.steps || []) {
        log(`    - ${s.id} (${s.kind})`);
      }

      const quoteId = saveBridgeQuote(result, originChain, destinationChain, wallet.provider, wallet.address);
      log(`\n  Quote ID: ${quoteId}`);
      log(`  Execute:  nansen bridge execute --quote ${quoteId}`);
      log('');
      return undefined;
    },

    'execute': async (args, apiInstance, flags, options) => {
      const quoteId = options.quote || args[0];
      const walletName = options.wallet;

      if (!quoteId) {
        throw new Error(
          `Usage: nansen bridge execute --quote <quoteId> [--wallet <name>]

Execute a cached bridge quote. Signs transactions and broadcasts them.`,
        );
      }

      const quoteData = loadBridgeQuote(quoteId);
      const { execution_type, steps, request_id } = quoteData.response;

      log(`\n  Executing bridge: ${quoteData.originChain} → ${quoteData.destinationChain}`);
      log(`  Type: ${execution_type}`);
      log(`  Steps: ${steps.length}`);

      const creds = resolveWalletCredentials(walletName);

      if (execution_type === 'evm_transaction') {
        for (const step of steps) {
          await processEvmStep(step, {
            chain: quoteData.originChain,
            privateKeyHex: creds.privateKey,
            log,
          });
        }
      } else if (execution_type === 'hyperliquid_signature') {
        if (creds.provider === 'privy') {
          const { PrivyClient } = await import('./privy.js');
          const privyClient = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
          const wallet = resolveWalletAddress(walletName);
          for (const step of steps) {
            await processSignatureStepPrivy(step, {
              privyClient,
              walletId: wallet.privyWalletIds?.evm,
              log,
              apiInstance,
            });
          }
        } else {
          for (const step of steps) {
            await processSignatureStepLocal(step, {
              privateKeyHex: creds.privateKey,
              log,
              apiInstance,
            });
          }
        }
      } else {
        throw new Error(`Unknown execution type: ${execution_type}`);
      }

      log(`\n  Bridge submitted. Polling for completion...`);
      const status = await pollBridgeCompletion(apiInstance, { requestId: request_id, log });

      if (status.status === 'success') {
        log(`\n  Bridge completed!`);
        if (status.destination_tx_hashes?.length) {
          log(`  Destination tx: ${status.destination_tx_hashes[0]}`);
        }
      }
      log('');
      return undefined;
    },

    'status': async (args, apiInstance, flags, options) => {
      const requestId = options['request-id'] || args[0];
      const txHash = options['tx-hash'];

      if (!requestId && !txHash) {
        throw new Error(
          `Usage: nansen bridge status --request-id <id> or --tx-hash <hash>

Check the status of a Hyperliquid bridge transaction.`,
        );
      }

      const status = await getBridgeStatus(apiInstance, { requestId, txHash });

      log(`\n  Bridge Status: ${status.status}`);
      if (status.raw_status) log(`  Raw:     ${status.raw_status}`);
      if (status.source_tx_hashes?.length) log(`  Source:  ${status.source_tx_hashes.join(', ')}`);
      if (status.destination_tx_hashes?.length) log(`  Dest:    ${status.destination_tx_hashes.join(', ')}`);
      log('');
      return undefined;
    },
  };
}
