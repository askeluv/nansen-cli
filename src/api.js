/**
 * Nansen API Client
 * Handles all HTTP communication with the Nansen API
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EVM_CHAINS } from './chain-ids.js';
import { getAnonymousId, TELEMETRY_DISABLED } from './telemetry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function telemetryHeaders() {
  if (TELEMETRY_DISABLED) return {};
  return { 'X-Anonymous-Id': getAnonymousId() };
}

export const { version: packageVersion } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

// ============= Error Codes =============

/**
 * Structured error codes for programmatic handling by AI agents
 */
export const ErrorCode = {
  // Authentication & Authorization
  UNAUTHORIZED: 'UNAUTHORIZED',           // 401 - Invalid or missing API key
  FORBIDDEN: 'FORBIDDEN',                 // 403 - Valid key but insufficient permissions
  CREDITS_EXHAUSTED: 'CREDITS_EXHAUSTED', // 403 - Insufficient API credits
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',   // 402 - x402 payment required
  
  // Rate Limiting
  RATE_LIMITED: 'RATE_LIMITED',           // 429 - Too many requests
  
  // Validation Errors
  INVALID_ADDRESS: 'INVALID_ADDRESS',     // Address format validation failed
  INVALID_TOKEN: 'INVALID_TOKEN',         // Token address validation failed
  INVALID_CHAIN: 'INVALID_CHAIN',         // Unsupported or invalid chain
  INVALID_PARAMS: 'INVALID_PARAMS',       // Generic parameter validation error
  MISSING_PARAM: 'MISSING_PARAM',         // Required parameter not provided
  UNSUPPORTED_FILTER: 'UNSUPPORTED_FILTER', // Filter not supported for this token/chain
  
  // Resource Errors
  NOT_FOUND: 'NOT_FOUND',                 // 404 - Resource not found
  TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND',     // Token doesn't exist
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND', // Address has no data
  
  // Server Errors
  SERVER_ERROR: 'SERVER_ERROR',           // 500+ - Nansen API internal error
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE', // 503 - API temporarily down
  
  // Client Errors
  NETWORK_ERROR: 'NETWORK_ERROR',         // Connection failed
  TIMEOUT: 'TIMEOUT',                     // Request timed out
  
  // Generic
  UNKNOWN: 'UNKNOWN',                     // Unclassified error
};

/**
 * Error thrown by command handlers for user-facing failures (validation errors,
 * missing args, etc.).
 *
 * Handlers must throw rather than calling log() + exit() directly, because
 * direct exits bypass runCLI's catch block and skip telemetry tracking.
 *
 * runCLI outputs CommandError.message as plain text (not JSON-formatted like
 * NansenError), then fires trackCommandFailed before exiting.
 *
 * When `data` is provided, runCLI outputs JSON.stringify(data) instead of the
 * plain message — this preserves structured JSON output for errors that agents
 * parse (e.g. PASSWORD_REQUIRED, API_KEY_REQUIRED).
 */
export class CommandError extends Error {
  constructor(message, code = 'COMMAND_ERROR', data = null) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Custom error class with structured error codes
 */
export class NansenError extends Error {
  constructor(message, code = ErrorCode.UNKNOWN, status = null, data = null) {
    super(message);
    this.name = 'NansenError';
    this.code = code;
    this.status = status;
    this.details = data;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      details: this.details,
    };
  }
}

/**
 * Map HTTP status codes to error codes
 */
export function statusToErrorCode(status, data = {}) {
  const message = data?.message || data?.error || '';
  const messageLower = message.toLowerCase();
  
  switch (status) {
    case 400:
    case 422:
      if (messageLower.includes('field') && messageLower.includes('not recognized')) return ErrorCode.UNSUPPORTED_FILTER;
      if (messageLower.includes('address')) return ErrorCode.INVALID_ADDRESS;
      if (messageLower.includes('token')) return ErrorCode.INVALID_TOKEN;
      if (messageLower.includes('chain')) return ErrorCode.INVALID_CHAIN;
      return ErrorCode.INVALID_PARAMS;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 402:
      return ErrorCode.PAYMENT_REQUIRED;
    case 403:
      if (messageLower.includes('credit') || messageLower.includes('insufficient')) return ErrorCode.CREDITS_EXHAUSTED;
      return ErrorCode.FORBIDDEN;
    case 404:
      if (messageLower.includes('token')) return ErrorCode.TOKEN_NOT_FOUND;
      if (messageLower.includes('address') || messageLower.includes('wallet')) return ErrorCode.ADDRESS_NOT_FOUND;
      return ErrorCode.NOT_FOUND;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 500:
    case 502:
      return ErrorCode.SERVER_ERROR;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    case 504:
      return ErrorCode.TIMEOUT;
    default:
      if (status >= 500) return ErrorCode.SERVER_ERROR;
      if (status >= 400) return ErrorCode.INVALID_PARAMS;
      return ErrorCode.UNKNOWN;
  }
}

// ============= Config Paths =============

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Get the config directory path
 */
export function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Get the config file path
 */
export function getConfigFile() {
  return CONFIG_FILE;
}

/**
 * Save config to ~/.nansen/config.json
 */
export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Delete config file (logout)
 */
export function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    return true;
  }
  return false;
}

// ============= Response Cache =============

const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
const DEFAULT_CACHE_TTL = 300; // 5 minutes

import crypto from 'crypto';

/**
 * Generate cache key from endpoint and request body
 */
function getCacheKey(endpoint, body) {
  const data = JSON.stringify({ endpoint, body });
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Get cached response if valid
 */
export function getCachedResponse(endpoint, body, ttlSeconds = DEFAULT_CACHE_TTL) {
  const cacheKey = getCacheKey(endpoint, body);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  
  if (!fs.existsSync(cacheFile)) {
    return null;
  }
  
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const age = (Date.now() - cached.timestamp) / 1000;
    
    if (ttlSeconds <= 0 || age > ttlSeconds) {
      // Cache expired or TTL is 0, delete it
      fs.unlinkSync(cacheFile);
      return null;
    }
    
    return { ...cached.data, _meta: { ...cached.data._meta, fromCache: true, cacheAge: Math.round(age) } };
  } catch (_e) {
    // Invalid cache file, delete it
    try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Save response to cache
 */
export function setCachedResponse(endpoint, body, data) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { mode: 0o700, recursive: true });
  }
  
  const cacheKey = getCacheKey(endpoint, body);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  
  const cached = {
    timestamp: Date.now(),
    endpoint,
    data
  };
  
  fs.writeFileSync(cacheFile, JSON.stringify(cached), { mode: 0o600 });
}

/**
 * Clear all cached responses
 */
export function clearCache() {
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
    return files.length;
  }
  return 0;
}

/**
 * Get cache directory path
 */
export function getCacheDir() {
  return CACHE_DIR;
}

// ============= Address Validation =============

const ADDRESS_PATTERNS = {
  // EVM chains: 0x followed by 40 hex chars
  evm: /^0x[a-fA-F0-9]{40}$/,
  // Solana: Base58, 32-44 chars (no 0, O, I, l)
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  // Bitcoin: Various formats
  bitcoin: /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/,
};

/**
 * Validate address format for a given chain
 * @param {string} address - The address to validate
 * @param {string} chain - The blockchain (ethereum, solana, etc.)
 * @returns {{valid: boolean, error?: string, code?: string}}
 */
export function validateAddress(address, chain = 'ethereum') {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required', code: ErrorCode.MISSING_PARAM };
  }

  const trimmed = address.trim();
  
  if (EVM_CHAINS.includes(chain)) {
    if (!ADDRESS_PATTERNS.evm.test(trimmed)) {
      return { valid: false, error: `Invalid EVM address format. Expected 0x followed by 40 hex characters.`, code: ErrorCode.INVALID_ADDRESS };
    }
  } else if (chain === 'solana') {
    if (!ADDRESS_PATTERNS.solana.test(trimmed)) {
      return { valid: false, error: `Invalid Solana address format. Expected Base58 string (32-44 chars).`, code: ErrorCode.INVALID_ADDRESS };
    }
  } else if (chain === 'bitcoin') {
    if (!ADDRESS_PATTERNS.bitcoin.test(trimmed)) {
      return { valid: false, error: `Invalid Bitcoin address format.`, code: ErrorCode.INVALID_ADDRESS };
    }
  }
  // For unknown chains, allow any non-empty string (API will validate)
  
  return { valid: true };
}

/**
 * Normalize EVM address to lowercase for API compatibility.
 * The API should handle case-insensitive addresses server-side, but this is
 * a defensive client-side measure since checksummed addresses currently
 * return empty results.
 */
export function normalizeAddress(address, chain = 'ethereum') {
  if (address && typeof address === 'string' && address.startsWith('0x') && EVM_CHAINS.includes(chain)) {
    return address.toLowerCase();
  }
  return address;
}

/**
 * Validate token address (same rules as wallet address)
 */
export function validateTokenAddress(tokenAddress, chain = 'solana') {
  return validateAddress(tokenAddress, chain);
}

function loadConfig() {
  // Base config from files, then env vars override individual fields
  let config = null;

  // ~/.nansen/config.json (from `nansen login`)
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_e) { /* ignore */ }
  }

  // Local config.json (for development)
  if (!config) {
    const localConfig = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(localConfig)) {
      config = JSON.parse(fs.readFileSync(localConfig, 'utf8'));
    }
  }

  if (!config) {
    config = { apiKey: null, baseUrl: 'https://api.nansen.ai' };
  }

  // Ensure baseUrl default (config file from older versions may omit it)
  if (!config.baseUrl) {
    config.baseUrl = 'https://api.nansen.ai';
  }

  // Env vars override individual fields
  if (process.env.NANSEN_API_KEY) {
    config.apiKey = process.env.NANSEN_API_KEY;
  }
  if (process.env.NANSEN_BASE_URL) {
    config.baseUrl = process.env.NANSEN_BASE_URL;
  }

  return config;
}

const config = loadConfig();

// ============= Retry Configuration =============

const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryOnStatus: [429, 500, 502, 503, 504],
};

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoff(attempt, baseDelayMs, maxDelayMs, retryAfterMs = null) {
  // If server specifies retry-after, use it (with some jitter)
  if (retryAfterMs) {
    const jitter = Math.random() * 1000;
    return Math.min(retryAfterMs + jitter, maxDelayMs);
  }
  
  // Exponential backoff: base * 2^attempt + random jitter
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Parse retry-after header (supports seconds or HTTP date)
 */
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  
  // Try parsing as seconds
  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }
  
  // Try parsing as HTTP date
  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  
  return null;
}

/**
 * Build a date range from today back N days
 * @param {number} days - Number of days back from today
 * @returns {{from: string, to: string}} Date range with YYYY-MM-DD strings
 */
export function buildDateRange(days) {
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return { from, to };
}

export class NansenAPI {
  constructor(apiKey = config.apiKey, baseUrl = config.baseUrl, options = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.cacheOptions = {
      enabled: options.cache?.enabled ?? false,
      ttl: options.cache?.ttl ?? DEFAULT_CACHE_TTL
    };
    this.defaultHeaders = options.defaultHeaders || {};
  }

  static cleanBody(body) {
    return Object.fromEntries(
      Object.entries(body).filter(([_, v]) =>
        v !== undefined && v !== null &&
        !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      )
    );
  }

  /**
   * Retry a POST request with a payment signature.
   * Returns parsed JSON if the paid request succeeds, or null if still rejected.
   * Logs the payment and warns about low balance when walletLabel and network are given.
   *
   * @param {string} signature - Payment-Signature header value
   * @param {string|null} walletLabel - Display label for logging, e.g. "local wallet alice"
   * @param {string|null} network - x402 network string for balance check, e.g. "eip155:8453"
   * @param {string} url - Request URL
   * @param {object} body - Request body (will be cleaned)
   * @param {object} [options={}] - Request options (may include .headers)
   * @returns {Promise<object|null>} Parsed JSON on success, null if rejected
   *
   * TODO: full fix — extract the entire x402 provider dispatch from request() into
   * an attemptX402Payment() method so adding a new payment provider only requires
   * touching that one method, not hunting inside the retry loop.
   */
  async _x402Retry(signature, walletLabel, network, url, body, options = {}) {
    const paidResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Type': 'nansen-cli',
        'X-Client-Version': packageVersion,
        ...telemetryHeaders(),
        'Payment-Signature': signature,
        ...this.defaultHeaders,
        ...options.headers,
      },
      body: JSON.stringify(NansenAPI.cleanBody(body)),
    });
    if (!paidResponse.ok) return null;
    if (walletLabel) {
      console.error(`[x402] Paid via ${walletLabel}${network ? ` (${network})` : ''}`);
    }
    if (network) {
      try {
        const { checkX402Balance } = await import('./x402.js');
        const balance = await checkX402Balance(network);
        if (balance !== null && balance < 0.25) {
          console.error(`[x402] Warning: USDC balance low ($${balance.toFixed(2)}). Fund your wallet to avoid interruptions.`);
        }
      } catch { /* balance check is best-effort */ }
    }
    return await paidResponse.json();
  }

  async request(endpoint, body = {}, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const { maxRetries, baseDelayMs, maxDelayMs, retryOnStatus } = this.retryOptions;
    const shouldRetry = options.retry !== false; // Allow disabling retry per-request
    
    // Check cache first (if enabled and not bypassed)
    const useCache = options.cache !== false && this.cacheOptions.enabled;
    const cacheTtl = options.cacheTtl ?? this.cacheOptions.ttl;
    
    if (useCache) {
      const cached = getCachedResponse(endpoint, body, cacheTtl);
      if (cached) {
        return cached;
      }
    }

    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response;
      try {
        const method = options.method || 'POST';
        const isGet = method === 'GET';
        response = await fetch(url, {
          method,
          headers: {
            ...(!isGet && { 'Content-Type': 'application/json' }),
            'X-Client-Type': 'nansen-cli',
            'X-Client-Version': packageVersion,
            ...telemetryHeaders(),
            ...(this.apiKey ? { 'apikey': this.apiKey } : {}),
            ...this.defaultHeaders,
            ...options.headers
          },
          ...(!isGet && method !== 'DELETE' && { body: JSON.stringify(NansenAPI.cleanBody(body)) })
        });
      } catch (err) {
        // Network-level errors - retry these too
        lastError = new NansenError(
          `Network error: ${err.message}`,
          ErrorCode.NETWORK_ERROR,
          null,
          { originalError: err.message, attempt: attempt + 1 }
        );
        
        if (shouldRetry && attempt < maxRetries) {
          const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
          await sleep(delayMs);
          continue;
        }
        throw lastError;
      }

      let data;
      try {
        data = await response.json();
      } catch (_err) {
        // Non-JSON response (rare, usually server errors)
        const error = new NansenError(
          `Invalid response from API (status ${response.status})`,
          response.status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.UNKNOWN,
          response.status,
          { body: await response.text().catch(() => null), attempt: attempt + 1 }
        );
        
        if (shouldRetry && attempt < maxRetries && response.status >= 500) {
          const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
          await sleep(delayMs);
          lastError = error;
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        let message = data.message || data.error
          || (typeof data.detail === 'string' ? data.detail : data.detail?.message)
          || `API error: ${response.status}`;
        // nansen-api proxy stringifies nested error dicts via Python str(), producing
        // "{'message': 'actual error', ...}". Extract the inner message if present.
        const nestedMatch = typeof message === 'string' && message.match(/['"]message['"]\s*:\s*['"](.*?)['"]/);
        if (nestedMatch) message = nestedMatch[1];
        const code = statusToErrorCode(response.status, data);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

        // Enhance messages for specific error codes
        if (code === ErrorCode.UNAUTHORIZED) {
          message = this.apiKey ? message : 'Not logged in. Run: nansen login';
        } else if (code === ErrorCode.UNSUPPORTED_FILTER) {
          message = message.replace(/\.+$/, '') + '. This filter is not supported for this token/chain combination. Do not retry.';
        } else if (code === ErrorCode.CREDITS_EXHAUSTED) {
          message = message.replace(/\.+$/, '') + '. No retry will help. Check your Nansen dashboard for credit balance.';
        } else if (code === ErrorCode.PAYMENT_REQUIRED) {
          // Try x402 auto-payment: local wallet (with network fallback), then WalletConnect
          const hasManualSignature = !!(this.defaultHeaders['Payment-Signature'] || options.headers?.['Payment-Signature']);

          if (!hasManualSignature) {
            // Determine payment method from default wallet's provider
            let defaultWalletProvider = 'local';
            let defaultWalletName = 'unknown';
            try {
              const { getWalletConfig, showWallet } = await import('./wallet.js');
              const walletConfig = getWalletConfig();
              if (walletConfig.defaultWallet) {
                defaultWalletName = walletConfig.defaultWallet;
                const wallet = showWallet(walletConfig.defaultWallet);
                defaultWalletProvider = wallet.provider || 'local';
              }
            } catch (err) {
              if (process.env.DEBUG) console.error(`[x402] Failed to detect wallet provider: ${err.message}`);
            }

            if (defaultWalletProvider === 'privy') {
              // Default wallet is Privy: sign via Privy
              try {
                const { createPrivyPaymentSignatures } = await import('./privy.js');
                for await (const { signature, network } of createPrivyPaymentSignatures(response, url)) {
                  const result = await this._x402Retry(signature, `Privy wallet ${defaultWalletName}`, network, url, body, options);
                  if (result !== null) return result;
                }
              } catch (privyErr) {
                message = `x402 Privy payment failed: ${privyErr.message}`;
              }
            } else {
              // Local wallet or no wallet: existing local wallet + WalletConnect flow
              // 1. Try local wallet with fallback across payment networks
              try {
                const { createPaymentSignatures } = await import('./x402.js');
                for await (const { signature, network } of createPaymentSignatures(response, url)) {
                  const result = await this._x402Retry(signature, `local wallet ${defaultWalletName}`, network, url, body, options);
                  if (result !== null) return result;
                  // This payment option was rejected, try next
                }
              } catch { /* local wallet unavailable, try WalletConnect */ }

              // 2. Fall back to WalletConnect (walletconnect-x402.js)
              {
                let paymentRequirements;
                const paymentHeader = response.headers.get('payment-required');
                if (paymentHeader) {
                  try {
                    paymentRequirements = JSON.parse(atob(paymentHeader));
                  } catch {
                    data.paymentRequiredRaw = paymentHeader;
                  }
                }
                if (!paymentRequirements && data.paymentRequirements) {
                  paymentRequirements = data.paymentRequirements;
                }

                if (paymentRequirements) {
                  try {
                    const { handleX402Payment } = await import('./walletconnect-x402.js');
                    const paymentSignature = await handleX402Payment(paymentRequirements);
                    const result = await this._x402Retry(paymentSignature, 'WalletConnect', null, url, body, options);
                    if (result !== null) return result;
                  } catch (x402Err) {
                    if (!this.apiKey) {
                      message = 'No API key configured. Two ways to authenticate:\n' +
                        '  1. API key: nansen login --api-key <key> (get key at https://app.nansen.ai/auth/agent-setup)\n' +
                        '  2. x402 micropayment: nansen wallet create + fund with USDC (no API key needed)';
                    } else {
                      message = `x402 auto-payment failed: ${x402Err.message}`;
                    }
                  }
                  if (this.apiKey) {
                    data.paymentRequirements = paymentRequirements;
                  }
                }
              }
            }
          }

          if (!message || message === data.message) {
            message = 'Payment required (x402). Sign the paymentRequirements below per https://docs.x402.org and pass the result with --x402-payment-signature <value>.';
          }
        }

        lastError = new NansenError(message, code, response.status, {
          ...data,
          attempt: attempt + 1,
          retryAfterMs
        });
        
        // Retry on specific status codes
        if (shouldRetry && attempt < maxRetries && retryOnStatus.includes(response.status)) {
          const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs, retryAfterMs);
          await sleep(delayMs);
          continue;
        }
        
        throw lastError;
      }

      // Success - add retry metadata if we retried
      if (attempt > 0) {
        data._meta = { ...(data._meta || {}), retriedAttempts: attempt };
      }
      
      // Cache successful response
      if (useCache) {
        setCachedResponse(endpoint, body, data);
      }
      
      return data;
    }
    
    // Should not reach here, but just in case
    throw lastError;
  }

  // ============= Account Endpoint =============

  async getAccount() {
    return this.request('/api/v1/account', {}, { method: 'GET', cache: false });
  }

  // ============= Smart Money Endpoints =============
  
  async smartMoneyNetflow(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/netflow', {
      chains,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyDexTrades(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/dex-trades', {
      chains,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyPerpTrades(params = {}) {
    const { filters = {}, orderBy, pagination, onlyNewPositions } = params;
    return this.request('/api/v1/smart-money/perp-trades', {
      filters,
      order_by: orderBy,
      pagination,
      only_new_positions: onlyNewPositions
    });
  }

  async smartMoneyHoldings(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/holdings', {
      chains,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyDcas(params = {}) {
    const { filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/smart-money/dcas', {
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async smartMoneyHistoricalHoldings(params = {}) {
    const { chains = ['solana'], filters = {}, orderBy, pagination, days = 30 } = params;
    return this.request('/api/v1/smart-money/historical-holdings', {
      chains,
      date_range: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  // ============= Profiler Endpoints =============

  async addressBalance(params = {}) {
    const { address, entityName, chain = 'all', hideSpamToken = true, filters = {}, orderBy } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/profiler/address/current-balance', {
      address,
      entity_name: entityName,
      chain,
      hide_spam_token: hideSpamToken,
      filters,
      order_by: orderBy
    });
  }

  async addressLabels(params = {}) {
    const { address, chain = 'ethereum', pagination = { page: 1, per_page: 100 } } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/beta/profiler/address/labels', {
      parameters: { address, chain },
      pagination
    });
  }

  async addressTransactions(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30, date } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || buildDateRange(days);
    return this.request('/api/v1/profiler/address/transactions', {
      address,
      chain,
      date: dateRange,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPnl(params = {}) {
    const { address, chain = 'ethereum', date, days = 30, filters = {}, orderBy, pagination } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || buildDateRange(days);
    return this.request('/api/v1/profiler/address/pnl', {
      address,
      chain,
      date: dateRange,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async entitySearch(params = {}) {
    const { query } = params;
    return this.request('/api/v1/search/entity-name', {
      search_query: query
    });
  }

  async generalSearch(params = {}) {
    const { query, resultType = 'any', chain, limit = 25 } = params;
    if (!query) {
      throw new NansenError('Search query is required', ErrorCode.MISSING_PARAM);
    }
    const body = {
      search_query: query,
      result_type: resultType,
      limit
    };
    if (chain) body.chain = chain;
    return this.request('/api/v1/search/general', body);
  }

  async webSearch(params = {}) {
    const { queries, numResults = 10 } = params;
    if (!queries || queries.length === 0) {
      throw new NansenError('At least one query is required', ErrorCode.MISSING_PARAM);
    }
    return this.request('/api/v1/search/web-search', {
      queries,
      num_results: numResults,
    }, { cache: false });
  }

  async webFetch(params = {}) {
    const { urls, question } = params;
    if (!urls || urls.length === 0) {
      throw new NansenError('At least one URL is required', ErrorCode.MISSING_PARAM);
    }
    if (!question) {
      throw new NansenError('A question is required', ErrorCode.MISSING_PARAM);
    }
    return this.request('/api/v1/search/web-fetch', {
      urls,
      question,
    }, { cache: false });
  }

  async addressHistoricalBalances(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/profiler/address/historical-balances', {
      address,
      chain,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressRelatedWallets(params = {}) {
    const { address, chain = 'ethereum', orderBy, pagination } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/profiler/address/related-wallets', {
      address,
      chain,
      order_by: orderBy,
      pagination
    });
  }

  async addressCounterparties(params = {}) {
    const { address, chain = 'ethereum', filters = {}, orderBy, pagination, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/profiler/address/counterparties', {
      address,
      chain,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async addressPnlSummary(params = {}) {
    // Note: pnl-summary endpoint is non-paginated (returns aggregate stats, not a list).
    // Pagination param intentionally omitted from this request.
    const { address, chain = 'ethereum', orderBy, days = 30 } = params;
    if (address) {
      const validation = validateAddress(address, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/profiler/address/pnl-summary', {
      address,
      chain,
      date: buildDateRange(days),
      order_by: orderBy
    });
  }

  async addressPerpPositions(params = {}) {
    const { address, filters = {}, orderBy } = params;
    // Perp positions work with HL addresses (not validated)
    // Note: This endpoint does NOT support pagination parameter
    return this.request('/api/v1/profiler/perp-positions', {
      address,
      filters,
      order_by: orderBy
    });
  }

  async addressPerpTrades(params = {}) {
    const { address, filters = {}, orderBy, pagination, days = 30 } = params;
    return this.request('/api/v1/profiler/perp-trades', {
      address,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  // ============= Token God Mode Endpoints =============

  async tokenScreener(params = {}) {
    const { chains = ['solana'], timeframe = '24h', filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/token-screener', {
      chains,
      timeframe,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenHolders(params = {}) {
    const { tokenAddress, chain = 'solana', labelType = 'all_holders', filters = {}, orderBy, pagination, withLabels } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const body = {
      token_address: tokenAddress,
      chain,
      label_type: labelType,
      filters,
      order_by: orderBy,
      pagination
    };
    if (withLabels !== undefined) body.premium_labels = withLabels;
    return this.request('/api/v1/tgm/holders', body);
  }

  async tokenFlows(params = {}) {
    const { tokenAddress, chain = 'solana', label, filters = {}, orderBy, pagination, days = 30, date } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || buildDateRange(days);
    return this.request('/api/v1/tgm/flows', {
      token_address: tokenAddress,
      chain,
      date: dateRange,
      label,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenDexTrades(params = {}) {
    const { tokenAddress, chain = 'solana', onlySmartMoney = false, filters = {}, orderBy, pagination, days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    // Apply smart money filter via filters object
    if (onlySmartMoney) {
      filters.include_smart_money_labels = filters.include_smart_money_labels || 
        ['Fund', 'Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'];
    }
    
    return this.request('/api/v1/tgm/dex-trades', {
      token_address: tokenAddress,
      chain,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPnlLeaderboard(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 30, withLabels } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const body = {
      token_address: tokenAddress,
      chain,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    };
    if (withLabels !== undefined) body.premium_labels = withLabels;
    return this.request('/api/v1/tgm/pnl-leaderboard', body);
  }

  async tokenWhoBoughtSold(params = {}) {
    const { tokenAddress, chain = 'solana', buyOrSell = 'BUY', filters = {}, orderBy, pagination, days = 30, date } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    const dateRange = date || buildDateRange(days);
    return this.request('/api/v1/tgm/who-bought-sold', {
      token_address: tokenAddress,
      chain,
      buy_or_sell: buyOrSell,
      date: dateRange,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenFlowIntelligence(params = {}) {
    const { tokenAddress, chain = 'solana', timeframe = '1d' } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/flow-intelligence', {
      token_address: tokenAddress,
      chain,
      timeframe
    });
  }

  async tokenTransfers(params = {}) {
    const { tokenAddress, chain = 'solana', filters = {}, orderBy, pagination, days = 7 } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/transfers', {
      token_address: tokenAddress,
      chain,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenJupDca(params = {}) {
    const { tokenAddress, filters = {}, orderBy, pagination } = params;
    // JUP DCA is Solana-only
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, 'solana');
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/jup-dca', {
      token_address: tokenAddress,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPerpTrades(params = {}) {
    const { tokenSymbol, filters = {}, orderBy, pagination, days = 30 } = params;
    return this.request('/api/v1/tgm/perp-trades', {
      token_symbol: tokenSymbol,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPerpPositions(params = {}) {
    const { tokenSymbol, filters = {}, orderBy, pagination } = params;
    return this.request('/api/v1/tgm/perp-positions', {
      token_symbol: tokenSymbol,
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async tokenPerpPnlLeaderboard(params = {}) {
    const { tokenSymbol, filters = {}, orderBy, pagination, days = 30, withLabels } = params;
    const body = {
      token_symbol: tokenSymbol,
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    };
    if (withLabels !== undefined) body.premium_labels = withLabels;
    return this.request('/api/v1/tgm/perp-pnl-leaderboard', body);
  }

  async tokenIndicators(params = {}) {
    const { tokenAddress, chain = 'ethereum' } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/indicators', {
      token_address: tokenAddress,
      chain
    });
  }

  async tokenOhlcv(params = {}) {
    const { tokenAddress, chain = 'solana', timeframe } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/token-ohlcv', {
      token_address: tokenAddress,
      chain,
      timeframe,
    });
  }

  async tokenInformation(params = {}) {
    const { tokenAddress, chain = 'solana', timeframe = '1d' } = params;
    if (tokenAddress) {
      const validation = validateTokenAddress(tokenAddress, chain);
      if (!validation.valid) throw new NansenError(validation.error, validation.code);
    }
    return this.request('/api/v1/tgm/token-information', {
      token_address: tokenAddress,
      chain,
      timeframe
    });
  }

  async topTokens(params = {}) {
    const { marketCapGroup, limit = 25 } = params;
    const body = { limit };
    if (marketCapGroup) body.market_cap_group = marketCapGroup;
    return this.request('/api/v1/nansen-score/top-tokens', body);
  }

  // ============= Perp Endpoints =============

  async perpScreener(params = {}) {
    const { filters = {}, orderBy, pagination, days = 30 } = params;
    return this.request('/api/v1/perp-screener', {
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    });
  }

  async perpLeaderboard(params = {}) {
    const { filters = {}, orderBy, pagination, days = 30, withLabels } = params;
    const body = {
      date: buildDateRange(days),
      filters,
      order_by: orderBy,
      pagination
    };
    if (withLabels !== undefined) body.premium_labels = withLabels;
    return this.request('/api/v1/perp-leaderboard', body);
  }

  // ============= Prediction Market Endpoints =============

  async pmOhlcv(params = {}) {
    const { marketId, orderBy, sort, pagination } = params;
    if (!marketId) throw new NansenError('market_id is required. Run: nansen research pm market-screener --query "your search"', ErrorCode.MISSING_PARAM);
    return this.request('/api/v1/prediction-market/ohlcv', {
      market_id: marketId,
      order_by: orderBy || sort,
      pagination
    });
  }

  async pmOrderbook(params = {}) {
    const { marketId, pagination } = params;
    if (!marketId) throw new NansenError('market_id is required. Run: nansen research pm market-screener --query "your search"', ErrorCode.MISSING_PARAM);
    return this.request('/api/v1/prediction-market/orderbook', {
      market_id: marketId,
      pagination
    });
  }

  async pmTopHolders(params = {}) {
    const { marketId, orderBy, sort, pagination } = params;
    if (!marketId) throw new NansenError('market_id is required. Run: nansen research pm market-screener --query "your search"', ErrorCode.MISSING_PARAM);
    return this.request('/api/v1/prediction-market/top-holders', {
      market_id: marketId,
      order_by: orderBy || sort,
      pagination
    });
  }

  async pmTradesByMarket(params = {}) {
    const { marketId, orderBy, pagination } = params;
    if (!marketId) throw new NansenError('market_id is required. Run: nansen research pm market-screener --query "your search"', ErrorCode.MISSING_PARAM);
    return this.request('/api/v1/prediction-market/trades-by-market', {
      market_id: marketId,
      order_by: orderBy,
      pagination
    });
  }

  async pmTradesByAddress(params = {}) {
    const { address, orderBy, pagination } = params;
    // Polymarket runs exclusively on Polygon
    const validation = validateAddress(address, 'polygon');
    if (!validation.valid) throw new NansenError(validation.error, validation.code);
    return this.request('/api/v1/prediction-market/trades-by-address', {
      address,
      order_by: orderBy,
      pagination
    });
  }

  async pmMarketScreener(params = {}) {
    const { orderBy, sortBy = 'volume_24hr', query = '', status = '', tags, minLiquidity, maxLiquidity, minUniqueTraders24h, maxUniqueTraders24h, minVolume24hr, maxVolume24hr, negRisk, minOpenInterest, maxOpenInterest, endDateBefore, endDateAfter, minPrice, maxPrice, pagination } = params;
    const body = {
      sort_by: sortBy,
      query,
      status,
      pagination
    };
    if (orderBy) body.order_by = orderBy;
    if (tags && tags.length) body.tags = tags;
    if (minLiquidity != null) body.min_liquidity = minLiquidity;
    if (maxLiquidity != null) body.max_liquidity = maxLiquidity;
    if (minUniqueTraders24h != null) body.min_unique_traders_24h = minUniqueTraders24h;
    if (maxUniqueTraders24h != null) body.max_unique_traders_24h = maxUniqueTraders24h;
    if (minVolume24hr != null) body.min_volume_24hr = minVolume24hr;
    if (maxVolume24hr != null) body.max_volume_24hr = maxVolume24hr;
    if (negRisk != null) body.neg_risk = negRisk;
    if (minOpenInterest != null) body.min_open_interest = minOpenInterest;
    if (maxOpenInterest != null) body.max_open_interest = maxOpenInterest;
    if (endDateBefore) body.end_date_before = endDateBefore;
    if (endDateAfter) body.end_date_after = endDateAfter;
    if (minPrice != null) body.min_price = minPrice;
    if (maxPrice != null) body.max_price = maxPrice;
    return this.request('/api/v1/prediction-market/market-screener', body);
  }

  async pmEventScreener(params = {}) {
    const { orderBy, sortBy = 'volume_24hr', query = '', status = '', tags, minLiquidity, maxLiquidity, minUniqueTraders24h, maxUniqueTraders24h, minVolume24hr, maxVolume24hr, negRisk, minOpenInterest, maxOpenInterest, endDateBefore, endDateAfter, pagination } = params;
    const body = {
      sort_by: sortBy,
      query,
      status,
      pagination
    };
    if (orderBy) body.order_by = orderBy;
    if (tags && tags.length) body.tags = tags;
    if (minLiquidity != null) body.min_liquidity = minLiquidity;
    if (maxLiquidity != null) body.max_liquidity = maxLiquidity;
    if (minUniqueTraders24h != null) body.min_unique_traders_24h = minUniqueTraders24h;
    if (maxUniqueTraders24h != null) body.max_unique_traders_24h = maxUniqueTraders24h;
    if (minVolume24hr != null) body.min_volume_24hr = minVolume24hr;
    if (maxVolume24hr != null) body.max_volume_24hr = maxVolume24hr;
    if (negRisk != null) body.neg_risk = negRisk;
    if (minOpenInterest != null) body.min_open_interest = minOpenInterest;
    if (maxOpenInterest != null) body.max_open_interest = maxOpenInterest;
    if (endDateBefore) body.end_date_before = endDateBefore;
    if (endDateAfter) body.end_date_after = endDateAfter;
    return this.request('/api/v1/prediction-market/event-screener', body);
  }

  async pmPnlByMarket(params = {}) {
    const { marketId, orderBy, pagination } = params;
    if (!marketId) throw new NansenError('market_id is required. Run: nansen research pm market-screener --query "your search"', ErrorCode.MISSING_PARAM);
    return this.request('/api/v1/prediction-market/pnl-by-market', {
      market_id: marketId,
      order_by: orderBy,
      pagination
    });
  }

  async pmPnlByAddress(params = {}) {
    const { address, orderBy, pagination } = params;
    // Polymarket runs exclusively on Polygon
    const validation = validateAddress(address, 'polygon');
    if (!validation.valid) throw new NansenError(validation.error, validation.code);
    return this.request('/api/v1/prediction-market/pnl-by-address', {
      address,
      order_by: orderBy,
      pagination
    });
  }

  async pmPositionDetail(params = {}) {
    const { marketId, pagination } = params;
    if (!marketId) throw new NansenError('market_id is required. Run: nansen research pm market-screener --query "your search"', ErrorCode.MISSING_PARAM);
    return this.request('/api/v1/prediction-market/position-detail', {
      market_id: marketId,
      pagination
    });
  }

  async pmCategories(params = {}) {
    const { pagination } = params;
    return this.request('/api/v1/prediction-market/categories', {
      pagination
    });
  }

  async pmAddressSummary(params = {}) {
    const { address, pagination } = params;
    // Polymarket runs exclusively on Polygon
    const validation = validateAddress(address, 'polygon');
    if (!validation.valid) throw new NansenError(validation.error, validation.code);
    return this.request('/api/v1/prediction-market/address-summary', {
      address,
      pagination
    });
  }

  // ============= Points Endpoints =============

  async pointsLeaderboard(params = {}) {
    const { tier, pagination } = params;
    return this.request('/api/v1/points/leaderboard', {
      tier,
      pagination
    });
  }

  // ============= Portfolio Endpoints =============

  async portfolioDefiHoldings(params = {}) {
    const { walletAddress } = params;
    return this.request('/api/v1/portfolio/defi-holdings', {
      wallet_address: walletAddress
    });
  }

  // ============= Smart Alert Endpoints =============

  async alertsList(params = {}) {
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const qs = Object.keys(defined).length > 0 ? '?' + new URLSearchParams(defined).toString() : '';
    return this.request(`/api/v1/smart-alert/list${qs}`, {}, { method: 'GET' });
  }

  async alertsCreate(params = {}) {
    return this.request('/api/v1/smart-alert', params);
  }

  async alertsUpdate(params = {}) {
    return this.request('/api/v1/smart-alert', params, { method: 'PATCH' });
  }

  async alertsToggle(params = {}) {
    return this.request('/api/v1/smart-alert/toggle', params, { method: 'PATCH' });
  }

  async alertsGet(id) {
    // TODO: replace with GET /api/v1/smart-alert/{id} once a get-by-id endpoint exists.
    // Fetching the full list does not scale for users with many alerts.
    const result = await this.alertsList();
    const alerts = Array.isArray(result) ? result : result?.alerts ?? result?.data ?? [];
    return alerts.find(a => a.id === id) ?? null;
  }

  async alertsDelete(alertId) {
    return this.request(`/api/v1/smart-alert/${encodeURIComponent(alertId)}`, {}, { method: 'DELETE' });
  }
}

export default NansenAPI;
