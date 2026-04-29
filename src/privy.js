/**
 * Privy Server Wallet Integration
 *
 * Two concerns:
 * 1. PrivyClient - thin REST wrapper for Privy's server wallet API
 * 2. createPrivyPaymentSignatures - x402 auto-payment via Privy signing
 */

import fs from "fs";
import path from "path";
import { parsePaymentRequirements } from "./x402.js";
import { isEvmNetwork } from "./x402-evm.js";
import {
  isSvmNetwork,
  getSolanaRpcUrl,
  fetchRecentBlockhash,
  buildUnsignedSvmTransaction,
} from "./x402-svm.js";
import {
  buildEIP712TypedData,
  buildPaymentSignatureHeader,
} from "./walletconnect-x402.js";

// ============= Constants =============

const PRIVY_BASE_URL = "https://api.privy.io/v1";

// ============= PrivyClient =============

export class PrivyClient {
  constructor(appId, appSecret) {
    if (!appId || !appSecret) {
      throw new Error(
        "Privy credentials required. Set PRIVY_APP_ID and PRIVY_APP_SECRET environment variables. Get them at https://dashboard.privy.io"
      );
    }
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = PRIVY_BASE_URL;
  }

  async _request(method, endpoint, body = null) {
    const auth = Buffer.from(`${this.appId}:${this.appSecret}`).toString(
      "base64"
    );
    const headers = {
      Authorization: `Basic ${auth}`,
      "privy-app-id": this.appId,
      "Content-Type": "application/json",
    };

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const response = await fetch(`${this.baseUrl}${endpoint}`, opts);

    if (!response.ok) {
      let msg = `Privy API error: ${response.status}`;
      try {
        const data = await response.json();
        msg = data.message || data.error || msg;
      } catch { /* non-JSON error response (e.g. 502 from CDN) */ }
      throw new Error(msg);
    }

    return await response.json();
  }

  async createWallet(chainType = "ethereum") {
    return this._request("POST", "/wallets", { chain_type: chainType });
  }

  async listWallets() {
    return this._request("GET", "/wallets");
  }

  async getWallet(walletId) {
    return this._request("GET", `/wallets/${walletId}`);
  }

  async deleteWallet(walletId) {
    return this._request("DELETE", `/wallets/${walletId}`);
  }

  async sendTransaction(walletId, { to, value, chainId, data: txData }) {
    const caip2 = `eip155:${chainId}`;
    return this._request("POST", `/wallets/${walletId}/rpc`, {
      method: "eth_sendTransaction",
      caip2,
      params: {
        transaction: {
          to,
          value,
          ...(txData ? { data: txData } : {}),
        },
      },
    });
  }

  async ethSignTypedDataV4(walletId, typedData) {
    // Privy uses snake_case "primary_type" instead of "primaryType"
    const privyTypedData = { ...typedData };
    if (privyTypedData.primaryType && !privyTypedData.primary_type) {
      privyTypedData.primary_type = privyTypedData.primaryType;
      delete privyTypedData.primaryType;
    }
    return this._request("POST", `/wallets/${walletId}/rpc`, {
      method: "eth_signTypedData_v4",
      params: { typed_data: privyTypedData },
    });
  }

  async signEvmTransaction(walletId, transaction) {
    return this._request("POST", `/wallets/${walletId}/rpc`, {
      method: "eth_signTransaction",
      params: { transaction },
    });
  }

  async signSolanaTransaction(walletId, transactionBase64) {
    return this._request("POST", `/wallets/${walletId}/rpc`, {
      method: "signTransaction",
      chain_type: "solana",
      params: { transaction: transactionBase64, encoding: "base64" },
    });
  }

  async signSolanaMessage(walletId, messageBuffer) {
    const messageBase64 = Buffer.from(messageBuffer).toString('base64');
    return this._request("POST", `/wallets/${walletId}/rpc`, {
      method: "signMessage",
      chain_type: "solana",
      params: { message: messageBase64, encoding: "base64" },
    });
  }

}

// ============= Helpers =============

function getClient() {
  return new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
}

/**
 * Create both an EVM and Solana wallet via Privy and store a local reference file.
 * Mirrors createWallet() in wallet.js but for Privy server wallets.
 */
export async function createPrivyWalletPair(name) {
  const WALLET_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!name || !WALLET_NAME_RE.test(name)) {
    throw new Error("Wallet name must be 1-64 characters: letters, numbers, hyphens, underscores only");
  }

  const walletsDir = path.join(process.env.HOME || process.env.USERPROFILE || "", ".nansen", "wallets");
  const walletFile = path.join(walletsDir, `${name}.json`);

  if (fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  const client = getClient();
  // Create wallets sequentially so we can clean up on partial failure
  const evmResult = await client.createWallet("ethereum");
  let solanaResult;
  try {
    solanaResult = await client.createWallet("solana");
  } catch (err) {
    // Clean up the EVM wallet we just created to avoid orphans
    try { await client.deleteWallet(evmResult.id); } catch { /* best effort */ }
    throw err;
  }

  const walletData = {
    name,
    provider: "privy",
    evm: { privyWalletId: evmResult.id, address: evmResult.address },
    solana: { privyWalletId: solanaResult.id, address: solanaResult.address },
    createdAt: new Date().toISOString(),
  };

  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { mode: 0o700, recursive: true });
  }

  // Write config before wallet file so a crash doesn't leave an orphan without a default entry
  const configPath = path.join(walletsDir, "config.json");
  let config = { defaultWallet: null, passwordHash: null };
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  if (!config.defaultWallet) {
    config.defaultWallet = name;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  fs.writeFileSync(walletFile, JSON.stringify(walletData, null, 2), { mode: 0o600 });

  return walletData;
}

// ============= x402 Payment Signing =============

/**
 * Resolve the EVM wallet for x402 payments.
 * Priority: PRIVY_WALLET_ID env > default local wallet's privyWalletId > first Privy EVM wallet.
 */
async function getPrivyEvmWallet(client) {
  if (process.env.PRIVY_WALLET_ID) {
    return client.getWallet(process.env.PRIVY_WALLET_ID);
  }

  // Prefer the wallet referenced by the local default wallet file
  try {
    const walletsDir = path.join(process.env.HOME || process.env.USERPROFILE || "", ".nansen", "wallets");
    const configPath = path.join(walletsDir, "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.defaultWallet) {
        const walletFile = path.join(walletsDir, `${config.defaultWallet}.json`);
        if (fs.existsSync(walletFile)) {
          const data = JSON.parse(fs.readFileSync(walletFile, "utf8"));
          if (data.provider === "privy" && data.evm?.privyWalletId) {
            return client.getWallet(data.evm.privyWalletId);
          }
        }
      }
    }
  } catch (err) {
    // Fall through to list-based detection
    if (process.env.DEBUG) console.error(`[x402] Default wallet lookup failed: ${err.message}`);
  }

  const result = await client.listWallets();
  const wallets = result.data || result.wallets || result;
  if (!Array.isArray(wallets)) return null;
  return wallets.find((w) => w.chain_type === "ethereum") || null;
}

/**
 * Resolve the Solana wallet for x402 payments.
 * Priority: default local wallet's solana.privyWalletId > first Privy Solana wallet.
 */
async function getPrivySolanaWallet(client) {
  try {
    const walletsDir = path.join(process.env.HOME || process.env.USERPROFILE || "", ".nansen", "wallets");
    const configPath = path.join(walletsDir, "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.defaultWallet) {
        const walletFile = path.join(walletsDir, `${config.defaultWallet}.json`);
        if (fs.existsSync(walletFile)) {
          const data = JSON.parse(fs.readFileSync(walletFile, "utf8"));
          if (data.provider === "privy" && data.solana?.privyWalletId) {
            return client.getWallet(data.solana.privyWalletId);
          }
        }
      }
    }
  } catch (err) {
    if (process.env.DEBUG) console.error(`[x402] Solana wallet lookup failed: ${err.message}`);
  }

  const result = await client.listWallets();
  const wallets = result.data || result.wallets || result;
  if (!Array.isArray(wallets)) return null;
  return wallets.find((w) => w.chain_type === "solana") || null;
}

/**
 * Generate payment signatures for x402 using Privy server wallets.
 * Same yield contract as createPaymentSignatures() in x402.js: { signature, network }
 *
 * @param {Response} response - The 402 HTTP response
 * @param {string} url - The original request URL
 * @returns {AsyncGenerator<{ signature: string, network: string }>}
 */
export async function* createPrivyPaymentSignatures(response, url) {
  const requirements = parsePaymentRequirements(response);
  if (!requirements || requirements.length === 0) return;

  const client = getClient();

  // EVM requirements
  const evmRequirements = requirements.filter((r) => isEvmNetwork(r.network));
  if (evmRequirements.length > 0) {
    const evmWallet = await getPrivyEvmWallet(client);
    if (evmWallet) {
      for (const requirement of evmRequirements) {
        try {
          const typedData = buildEIP712TypedData({
            fromAddress: evmWallet.address,
            requirement,
          });

          const signResult = await client.ethSignTypedDataV4(
            evmWallet.id,
            typedData
          );
          const signature = signResult.data?.signature || signResult.signature;

          const authorization = {
            from: evmWallet.address,
            to: requirement.payTo,
            value: (requirement.amount || requirement.maxAmountRequired).toString(),
            validAfter: typedData.message.validAfter.toString(),
            validBefore: typedData.message.validBefore.toString(),
            nonce: typedData.message.nonce,
          };

          const header = buildPaymentSignatureHeader({
            signature,
            authorization,
            resource: { url, description: "", mimeType: "" },
            accepted: requirement,
          });

          yield { signature: header, network: requirement.network };
        } catch (err) {
          console.error(`[x402] Privy EVM signing failed for ${requirement.network}: ${err.message}`);
          continue;
        }
      }
    } else {
      console.error('[x402] No Privy EVM wallet found for payment signing');
    }
  }

  // Solana requirements
  const svmRequirements = requirements.filter((r) => isSvmNetwork(r.network));
  if (svmRequirements.length > 0) {
    const solWallet = await getPrivySolanaWallet(client);
    if (solWallet) {
      for (const requirement of svmRequirements) {
        try {
          const rpcUrl = getSolanaRpcUrl(requirement.network);
          const recentBlockhash = await fetchRecentBlockhash(rpcUrl);

          const { txBase64 } = buildUnsignedSvmTransaction(
            requirement,
            solWallet.address,
            recentBlockhash,
          );

          const signResult = await client.signSolanaTransaction(solWallet.id, txBase64);
          const signedTx = signResult.data?.signed_transaction || signResult.signed_transaction;

          const payload = {
            x402Version: 2,
            payload: { transaction: signedTx },
            accepted: requirement,
          };
          if (url) {
            payload.resource = { url };
          }

          const header = Buffer.from(JSON.stringify(payload)).toString("base64");
          yield { signature: header, network: requirement.network };
        } catch (err) {
          console.error(`[x402] Privy Solana signing failed for ${requirement.network}: ${err.message}`);
          continue;
        }
      }
    } else {
      console.error('[x402] No Privy Solana wallet found for payment signing');
    }
  }
}
