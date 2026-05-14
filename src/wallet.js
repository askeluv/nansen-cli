/**
 * Nansen CLI - Wallet Management
 * Local key generation and storage for EVM and Solana chains.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as readline from 'readline';
import { base58 } from '@scure/base';
import { storePassword, retrievePassword, deletePassword, deleteCredentialsFile } from './keychain.js';
import { CommandError } from './api.js';

// ============= Constants =============

function getWalletsDir() {
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
  return path.join(configDir, 'wallets');
}
function getWalletConfigPath() {
  return path.join(getWalletsDir(), 'config.json');
}

// Encryption parameters
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const _AUTH_TAG_LEN = 16;

import { keccak256 } from './crypto.js';

// ============= Base58 Encoding (for Solana) =============

/**
 * Encode a Buffer to base58 string.
 */
export function base58Encode(buf) {
  return base58.encode(buf instanceof Uint8Array ? buf : Uint8Array.from(buf));
}

export function base58Decode(str) {
  return Buffer.from(base58.decode(str));
}

export function base58DecodePubkey(str) {
  const raw = base58Decode(str);
  if (raw.length === 32) return raw;
  if (raw.length < 32) return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  return raw.subarray(raw.length - 32);
}

// ============= Encryption =============

/**
 * Derive encryption key from password using scrypt.
 */
function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024, // 256MB — needed for N=131072
  });
}

/**
 * Encrypt a private key with a password.
 * Returns a JSON-serializable object with all params needed for decryption.
 */
export function encryptKey(privateKeyHex, password) {
  if (password === null) {
    return { data: privateKeyHex, encrypted: false };
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyHex, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

/**
 * Decrypt a private key with a password.
 * For unencrypted wallets (encrypted: false), password is ignored and
 * plaintext data is returned directly.
 */
export function decryptKey(encryptedData, password) {
  const ENCRYPTED_FIELDS = ['salt', 'iv', 'authTag', 'ciphertext'];
  const hasEncryptionFields = ENCRYPTED_FIELDS.some(f => f in encryptedData);

  // Unencrypted blob
  if (encryptedData.encrypted === false) {
    if (hasEncryptionFields) {
      throw new Error('Wallet data corrupted or tampered');
    }
    return encryptedData.data;
  }

  // Encrypted blob with missing fields
  if (!ENCRYPTED_FIELDS.every(f => f in encryptedData)) {
    throw new Error('Wallet data corrupted or tampered');
  }

  // Encrypted blob but no password provided
  if (password === null || password === undefined) {
    throw new Error('Wallet is encrypted. Set NANSEN_WALLET_PASSWORD.');
  }

  const salt = Buffer.from(encryptedData.salt, 'hex');
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const authTag = Buffer.from(encryptedData.authTag, 'hex');
  const ciphertext = Buffer.from(encryptedData.ciphertext, 'hex');
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Incorrect password');
  }
}

// ============= Key Generation =============

/**
 * Generate an EVM wallet (secp256k1).
 * Returns { privateKey, address } where address is checksummed.
 */
export function generateEvmWallet() {
  // Generate a random 32-byte private key
  const privateKey = crypto.randomBytes(32);

  // Derive public key (uncompressed, 65 bytes: 0x04 + x + y)
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(privateKey);
  const publicKey = ecdh.getPublicKey(null, 'uncompressed');

  // Address = last 20 bytes of keccak256(publicKey without 0x04 prefix)
  const hash = keccak256(publicKey.subarray(1));
  const addressBytes = hash.subarray(12);
  const addressHex = addressBytes.toString('hex');

  // EIP-55 checksum
  const addressHash = keccak256(Buffer.from(addressHex, 'utf8')).toString('hex');
  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    checksummed += parseInt(addressHash[i], 16) >= 8
      ? addressHex[i].toUpperCase()
      : addressHex[i];
  }

  const result = {
    privateKey: privateKey.toString('hex'),
    address: checksummed,
  };

  // Zero sensitive buffers (strings remain in heap — JS limitation)
  privateKey.fill(0);

  return result;
}

/**
 * Generate a Solana wallet (Ed25519).
 * Returns { privateKey, address } where address is base58 public key.
 */
export function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // Extract raw 32-byte keys from DER encoding
  // PKCS8 Ed25519 private key: last 32 bytes of the inner octet string
  // The raw private seed is at a fixed offset in the DER structure
  const rawPrivate = privateKey.subarray(privateKey.length - 32);
  // SPKI Ed25519 public key: last 32 bytes
  const rawPublic = publicKey.subarray(publicKey.length - 32);

  // Solana keypair format: 64 bytes = private seed (32) + public key (32)
  const keypair = Buffer.concat([rawPrivate, rawPublic]);

  return {
    privateKey: keypair.toString('hex'),
    address: base58Encode(rawPublic),
  };
}

// ============= Storage =============

function ensureWalletsDir() {
  if (!fs.existsSync(getWalletsDir())) {
    fs.mkdirSync(getWalletsDir(), { mode: 0o700, recursive: true });
  }
}

function warnIfInsecurePerms(filePath) {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode & 0o077) { // group or other has any access
      console.error(`⚠️  Warning: ${filePath} has insecure permissions (${mode.toString(8)}). Run: chmod 600 ${filePath}`);
    }
  } catch { /* ignore stat errors */ }
}

export function getWalletConfig() {
  if (!fs.existsSync(getWalletConfigPath())) {
    return { defaultWallet: null, passwordHash: null };
  }
  warnIfInsecurePerms(getWalletConfigPath());
  return JSON.parse(fs.readFileSync(getWalletConfigPath(), 'utf8'));
}

function saveWalletConfig(config) {
  ensureWalletsDir();
  fs.writeFileSync(getWalletConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

const WALLET_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function validateWalletName(name) {
  if (!name || !WALLET_NAME_RE.test(name)) {
    throw new Error('Wallet name must be 1-64 characters: letters, numbers, hyphens, underscores only');
  }
}

function getWalletFile(name) {
  validateWalletName(name);
  return path.join(getWalletsDir(), `${name}.json`);
}

function requireWalletFile(name) {
  const walletFile = getWalletFile(name);
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" not found`);
  }
  return walletFile;
}

/**
 * Verify the global password against stored hash.
 */
export function verifyPassword(password, config) {
  if (password == null) return false;
  if (!config.passwordHash) return true; // No password set yet
  const { salt, hash } = config.passwordHash;
  const derived = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}

/**
 * Create a password hash for storage (NOT the encryption key, just for verification).
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024,
  });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

// ============= Prompt Helper =============

async function promptPassword(question, deps = {}) {
  const promptFn = deps.promptFn;
  if (promptFn) {
    return promptFn(question, true);
  }
  // Fallback to readline (only available in --human mode)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (process.stdout.isTTY) {
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007F' || char === '\b') {
          input = input.slice(0, -1);
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

/**
 * Resolve wallet password from all available sources (non-interactive).
 * Order: NANSEN_WALLET_PASSWORD env var → OS keychain → .credentials file → null
 * Emits a warning to stderr when using the insecure .credentials file.
 * @returns {string|null}
 */
function resolveWalletPassword() {
  const { password, source } = retrievePassword();
  if (source === 'file') {
    process.stderr.write(
      '⚠️  Password loaded from ~/.nansen/wallets/.credentials (insecure — plaintext on disk).\n' +
      '   For better security, migrate to OS keychain: nansen wallet secure\n' +
      '   Or set NANSEN_WALLET_PASSWORD via a secrets manager.\n'
    );
  }
  return password;
}

/**
 * Resolve wallet password for a command. If --human flag is set and no
 * password found, falls back to interactive prompt. Otherwise returns
 * structured error info for agents.
 *
 * @param {object} config - wallet config (needs config.passwordHash)
 * @param {object} flags - CLI flags
 * @param {object} deps - { promptFn, log }
 * @returns {{ password: string|null, error: object|null }}
 */
async function resolvePasswordForCommand(config, flags, deps) {
  if (!config.passwordHash) {
    return { password: null, error: null };
  }

  const password = resolveWalletPassword();
  if (password) return { password, error: null };

  if (flags.human && (process.stdin.isTTY || deps.promptFn)) {
    const prompted = await promptPassword('Enter wallet password: ', deps);
    if (prompted) return { password: prompted, error: null };
  }

  return {
    password: null,
    error: {
      error: 'PASSWORD_REQUIRED',
      message: 'Wallet is encrypted and no password was found.',
      resolution: [
        'Set NANSEN_WALLET_PASSWORD environment variable',
        'Or re-run wallet create with the password (it will be persisted for future use)',
      ],
    },
  };
}

// ============= Public API =============

/**
 * List all wallets.
 */
export function listWallets() {
  ensureWalletsDir();
  const config = getWalletConfig();
  const files = fs.readdirSync(getWalletsDir()).filter(f => f.endsWith('.json') && f !== 'config.json');

  const wallets = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(getWalletsDir(), f), 'utf8'));
    return {
      name: data.name,
      provider: data.provider || 'local',
      evm: data.evm?.address || null,
      solana: data.solana?.address || null,
      createdAt: data.createdAt,
      isDefault: data.name === config.defaultWallet,
    };
  });

  return { wallets, defaultWallet: config.defaultWallet };
}

/**
 * Create a new wallet pair (EVM + Solana).
 */
export function createWallet(name, password) {
  ensureWalletsDir();
  const config = getWalletConfig();
  const walletFile = getWalletFile(name);

  if (fs.existsSync(walletFile)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  if (password === null) {
    // Passwordless mode: reject if existing wallets are encrypted
    if (config.passwordHash) {
      throw new Error('Existing wallets are password-protected. Set NANSEN_WALLET_PASSWORD.');
    }
  } else {
    // Encrypted mode
    if (!config.passwordHash) {
      // First encrypted wallet: reject if passwordless local wallets exist
      // (non-local wallets like Privy don't contain private keys, so skip them)
      const walletsDir = getWalletsDir();
      const existingLocalWallets = fs.readdirSync(walletsDir)
        .filter(f => f.endsWith('.json') && f !== 'config.json')
        .filter(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(walletsDir, f), 'utf8'));
            return !data.provider || data.provider === 'local';
          } catch { return true; }
        });
      if (existingLocalWallets.length > 0) {
        throw new Error('Existing wallets are passwordless. Cannot mix encrypted and unencrypted wallets.');
      }
      config.passwordHash = hashPassword(password);
    } else if (!verifyPassword(password, config)) {
      throw new Error('Incorrect password');
    }
  }

  const evm = generateEvmWallet();
  const solana = generateSolanaWallet();

  const wallet = {
    name,
    createdAt: new Date().toISOString(),
    evm: {
      address: evm.address,
      encrypted: encryptKey(evm.privateKey, password),
    },
    solana: {
      address: solana.address,
      encrypted: encryptKey(solana.privateKey, password),
    },
  };

  fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2), { mode: 0o600 });

  // Set as default if it's the first wallet
  if (!config.defaultWallet) {
    config.defaultWallet = name;
  }
  saveWalletConfig(config);

  return {
    name,
    evm: evm.address,
    solana: solana.address,
    isDefault: config.defaultWallet === name,
  };
}

/**
 * Show wallet details (addresses only, no keys).
 */
export function showWallet(name) {
  const walletFile = requireWalletFile(name);

  const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
  const config = getWalletConfig();
  const isPrivy = data.provider === 'privy';

  return {
    name: data.name,
    provider: data.provider || 'local',
    evm: data.evm?.address || null,
    solana: data.solana?.address || null,
    createdAt: data.createdAt,
    isDefault: data.name === config.defaultWallet,
    ...(isPrivy ? {
      privyWalletIds: {
        evm: data.evm?.privyWalletId,
        solana: data.solana?.privyWalletId,
      }
    } : {}),
  };
}

/**
 * Export private keys for a wallet (requires password).
 */
export function exportWallet(name, password) {
  const walletFile = requireWalletFile(name);

  const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
  if (data.provider && data.provider !== 'local') {
    throw new Error(`${data.provider} wallets don't support key export. Keys are managed by the provider.`);
  }

  const config = getWalletConfig();
  if (config.passwordHash && !verifyPassword(password, config)) {
    throw new Error('Incorrect password');
  }

  return {
    name: data.name,
    evm: {
      address: data.evm?.address,
      privateKey: data.evm ? decryptKey(data.evm.encrypted, password) : null,
    },
    solana: {
      address: data.solana?.address,
      privateKey: data.solana ? decryptKey(data.solana.encrypted, password) : null,
    },
  };
}

/**
 * Set the default wallet.
 */
export function setDefaultWallet(name) {
  requireWalletFile(name);

  const config = getWalletConfig();
  config.defaultWallet = name;
  saveWalletConfig(config);

  return { defaultWallet: name };
}

/**
 * Delete a wallet.
 */
export async function deleteWallet(name, password) {
  const walletFile = requireWalletFile(name);

  const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
  const config = getWalletConfig();

  if (data.provider && data.provider !== 'local') {
    // Non-local wallets: just remove local reference, no password needed
  } else {
    if (config.passwordHash && !verifyPassword(password, config)) {
      throw new Error('Incorrect password');
    }
  }

  fs.unlinkSync(walletFile);

  const remaining = fs.readdirSync(getWalletsDir()).filter(f => f.endsWith('.json') && f !== 'config.json');

  if (remaining.length === 0) {
    config.defaultWallet = null;
    config.passwordHash = null;
    deletePassword();
  } else if (config.defaultWallet === name) {
    config.defaultWallet = remaining[0].replace('.json', '');
  }
  saveWalletConfig(config);

  return { deleted: name, newDefault: config.defaultWallet };
}

// ============= CLI Command Builder =============

/**
 * Build wallet command handlers for integration into CLI.
 */
export function buildWalletCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    'wallet': async (args, apiInstance, flags, options) => {
      const subcommand = args[0] || 'help';

      // Privy-specific: only 'create' and policy commands need --provider privy
      if (options.provider === 'privy' || process.env.NANSEN_WALLET_PROVIDER === 'privy') {
        if (subcommand === 'create') {
          const { createPrivyWalletPair } = await import('./privy.js');
          const name = options.name || args[1] || 'default';
          try {
            const result = await createPrivyWalletPair(name);
            log(`\n✓ Privy wallet "${result.name}" created\n`);
            log(`  EVM:    ${result.evm.address}`);
            log(`  Solana: ${result.solana.address}`);
            log('');
            return;
          } catch (err) {
            throw new CommandError(`❌ ${err.message}`, 'PRIVY_ERROR');
          }
        }
        // All other subcommands fall through to unified handlers below
      }

      const isPrivy = options.provider === 'privy' || process.env.NANSEN_WALLET_PROVIDER === 'privy';

      const handlers = {
        'create': async () => {
          // Privy wallets are handled above — if we reach here with provider=privy,
          // the privy path already threw CommandError. Guard against environments
          // where throw does not propagate (agent frameworks, test harnesses).
          if (isPrivy) return;

          const name = options.name || args[1] || 'default';

          let password;
          if (flags['unsafe-no-password']) {
            process.stderr.write('WARNING: --unsafe-no-password is set. Private keys will be stored UNENCRYPTED on disk.\nAnyone with access to this machine can steal your funds.\n');
            password = null;
          } else {
            // Step 1: Check env var and keychain
            password = resolveWalletPassword();

            // Step 2: If --human flag, allow interactive prompt (requires TTY)
            if (!password && flags.human && !process.stdin.isTTY && !deps.promptFn) {
              throw new CommandError('--human requires an interactive terminal. Set NANSEN_WALLET_PASSWORD env var instead.', 'NOT_A_TTY', {
                error: 'NOT_A_TTY',
                message: '--human requires an interactive terminal. Set NANSEN_WALLET_PASSWORD env var instead.',
              });
            }
            if (!password && flags.human && (process.stdin.isTTY || deps.promptFn)) {
              password = await promptPassword('Enter wallet password: ', deps);
              if (password && password.length < 12) {
                throw new CommandError('❌ Password must be at least 12 characters', 'INVALID_INPUT');
              }
              if (password) {
                const config = getWalletConfig();
                if (!config.passwordHash) {
                  const confirm = await promptPassword('Confirm password: ', deps);
                  if (password !== confirm) {
                    throw new CommandError('❌ Passwords do not match', 'INVALID_INPUT');
                  }
                }
              }
            }

            // Step 3: No password available — return structured error for agents
            if (!password) {
              throw new CommandError('A wallet password is required. Ask the user to provide one.', 'PASSWORD_REQUIRED', {
                error: 'PASSWORD_REQUIRED',
                message: 'A wallet password is required. Ask the user to provide one.',
                instructions: 'Re-run with: NANSEN_WALLET_PASSWORD=<password> nansen wallet create',
                note: 'Password must be at least 12 characters. After creation, the password is saved to the OS keychain automatically — future operations will not require it.',
              });
            }

            if (password.length < 12) {
              throw new CommandError('❌ Password must be at least 12 characters', 'INVALID_INPUT');
            }
          }

          // Verify password matches existing wallets BEFORE touching keychain
          if (password !== null) {
            const config = getWalletConfig();
            if (config.passwordHash && !verifyPassword(password, config)) {
              throw new CommandError('❌ Incorrect password — does not match existing wallets.', 'INCORRECT_PASSWORD');
            }
          }

          // Persist password BEFORE creating wallet so we know the storage situation
          let storageResult = { stored: false, method: 'none' };
          if (password !== null) {
            storageResult = storePassword(password);
          }

          try {
            const result = createWallet(name, password);
            log(`\n✓ Wallet "${result.name}" created\n`);
            log(`  EVM:    ${result.evm}`);
            log(`  Solana: ${result.solana}`);
            if (result.isDefault) log(`  ★ Set as default wallet`);
            log('');
            log('  Fund this wallet to start making API calls or trading:');
            log(`    Base: send USDC to ${result.evm}`);
            log(`    Solana: send USDC to ${result.solana}`);
            log('');
            if (password === null) {
              log('  ⚠️  This is an UNENCRYPTED hot wallet — private keys are stored in plaintext on disk.');
            } else if (storageResult.stored && storageResult.method === 'keychain') {
              log('  ✓ Password saved to system keychain (secure).');
              log('    Future wallet operations will retrieve the password automatically.');
            } else if (storageResult.stored && storageResult.method === 'file') {
              log('  ⚠️  No OS keychain available. Password saved to ~/.nansen/wallets/.credentials (insecure — plaintext on disk).');
              log('     Future wallet operations will retrieve the password automatically.');
              log('     To improve security: migrate to OS keychain with `nansen wallet secure`,');
              log('     or set NANSEN_WALLET_PASSWORD via a secrets manager.');
            } else {
              log('  ⚠️  CRITICAL: Password could not be saved anywhere (no keychain, no writable filesystem).');
              log('     You MUST set NANSEN_WALLET_PASSWORD in your environment for ALL future wallet operations.');
              log('     If you lose this password, your funds are UNRECOVERABLE.');
            }
            if (password !== null) {
              log('');
              log('  IMPORTANT: Back up your password separately (e.g. password manager).');
              log('  If you lose access to this machine AND forget the password, funds are unrecoverable.');
              log('  This is a hot wallet — do not deposit more than you can afford to lose.');
            }
            log('');
            return;
          } catch (err) {
            throw new CommandError(`❌ ${err.message}`, 'CREATE_FAILED');
          }
        },

        'list': async () => {
          const result = listWallets();
          if (result.wallets.length === 0) {
            log('No wallets found. Create one with: nansen wallet create');
            return;
          }
          log('');
          for (const w of result.wallets) {
            const star = w.isDefault ? ' ★' : '';
            const providerTag = w.provider === 'privy' ? ' (privy)' : '';
            log(`  ${w.name}${star}${providerTag}`);
            log(`    EVM:    ${w.evm}`);
            log(`    Solana: ${w.solana}`);
            log('');
          }
        },

        'show': async () => {
          const name = options.name || args[1];
          if (!name) {
            throw new CommandError('Usage: nansen wallet show <name>', 'MISSING_ARGS');
          }
          try {
            const result = showWallet(name);
            const star = result.isDefault ? ' ★' : '';
            const providerTag = result.provider === 'privy' ? ' (privy)' : '';
            log(`\n  ${result.name}${star}${providerTag}`);
            log(`    EVM:    ${result.evm}`);
            log(`    Solana: ${result.solana}`);
            log(`    Created: ${result.createdAt}\n`);
            return;
          } catch (err) {
            throw new CommandError(`❌ ${err.message}`, 'SHOW_FAILED');
          }
        },

        'export': async () => {
          const name = options.name || args[1];
          if (!name) {
            throw new CommandError('Usage: nansen wallet export <name>', 'MISSING_ARGS');
          }

          const config = getWalletConfig();
          const { password, error } = await resolvePasswordForCommand(config, flags, deps);
          if (error) {
            throw new CommandError(error.message, 'PASSWORD_REQUIRED', error);
          }
          try {
            const result = exportWallet(name, password);
            log(`\n⚠️  Private keys for "${result.name}" — do not share!\n`);
            log(`  EVM:`);
            log(`    Address:     ${result.evm.address}`);
            log(`    Private Key: ${result.evm.privateKey}`);
            log(`  Solana:`);
            log(`    Address:     ${result.solana.address}`);
            log(`    Private Key: ${result.solana.privateKey}`);
            log('');
            return;
          } catch (err) {
            throw new CommandError(`❌ ${err.message}`, 'EXPORT_FAILED');
          }
        },

        'default': async () => {
          const name = options.name || args[1];
          if (!name) {
            throw new CommandError('Usage: nansen wallet default <name>', 'MISSING_ARGS');
          }
          try {
            const result = setDefaultWallet(name);
            log(`✓ Default wallet set to "${result.defaultWallet}"`);
            return;
          } catch (err) {
            throw new CommandError(`❌ ${err.message}`, 'DEFAULT_FAILED');
          }
        },

        'delete': async () => {
          const name = options.name || args[1];
          if (!name) {
            throw new CommandError('Usage: nansen wallet delete <name>', 'MISSING_ARGS');
          }

          // Check if this is a Privy wallet (no password needed)
          let isPrivy = false;
          try {
            const walletFile = path.join(getWalletsDir(), `${name}.json`);
            const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
            if (data.provider === 'privy') isPrivy = true;
          } catch { /* file might not exist, deleteWallet will throw */ }

          let password = null;
          if (!isPrivy) {
            const config = getWalletConfig();
            const resolved = await resolvePasswordForCommand(config, flags, deps);
            if (resolved.error) {
              throw new CommandError(resolved.error.message, 'PASSWORD_REQUIRED', resolved.error);
            }
            password = resolved.password;
          }

          try {
            const result = await deleteWallet(name, password);
            log(`✓ Wallet "${result.deleted}" deleted`);
            if (isPrivy) {
              log(`  Note: server-side wallet still exists on Privy`);
            }
            if (result.newDefault) {
              log(`  New default: ${result.newDefault}`);
            }
            return;
          } catch (err) {
            throw new CommandError(`❌ ${err.message}`, 'DELETE_FAILED');
          }
        },

        'send': async () => {
          const { sendTokens } = await import('./transfer.js');

          if (!options.to) {
            throw new CommandError('--to <address> is required', 'MISSING_ARGS');
          }

          const isMax = flags.max || options.amount === 'max';
          if (!options.amount && !isMax) {
            throw new CommandError('--amount <number> or --max is required', 'MISSING_ARGS');
          }

          if (!options.chain) {
            throw new CommandError('--chain <evm|solana> is required', 'MISSING_ARGS');
          }

          if (!['evm', 'solana', 'ethereum', 'base'].includes(options.chain)) {
            throw new CommandError('--chain must be one of: evm, solana, ethereum, base', 'INVALID_INPUT');
          }

          const isWalletConnect = options.wallet === 'walletconnect' || options.wallet === 'wc';

          // Check if the wallet is Privy (no password needed)
          let isPrivyWallet = false;
          if (!isWalletConnect) {
            try {
              const walletName = options.wallet || getWalletConfig().defaultWallet;
              if (walletName) {
                const walletFile = path.join(getWalletsDir(), `${walletName}.json`);
                const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
                if (data.provider === 'privy') isPrivyWallet = true;
              }
            } catch { /* ignore */ }
          }

          let password;
          if (isWalletConnect || isPrivyWallet) {
            password = null;
          } else {
            const sendConfig = getWalletConfig();
            const resolved = await resolvePasswordForCommand(sendConfig, flags, deps);
            if (resolved.error) {
              throw new CommandError(resolved.error.message, 'PASSWORD_REQUIRED', resolved.error);
            }
            password = resolved.password;
          }
          const dryRun = flags['dry-run'];

          try {
            const sendOpts = {
              to: options.to,
              amount: isMax ? '0' : String(options.amount),
              chain: options.chain,
              token: options.token || null,
              wallet: isWalletConnect ? null : (options.wallet || null),
              max: isMax,
              password,
              dryRun,
              walletconnect: isWalletConnect,
            };

            if (dryRun) {
              const result = await sendTokens(sendOpts);
              log(`\nDry run — transaction not broadcast\n`);
              log(`  From:   ${result.from}`);
              log(`  To:     ${options.to}`);
              log(`  Amount: ${result.amount || (isMax ? 'max' : String(options.amount))}`);
              log(`  Token:  ${options.token || '(native)'}`);
              log(`  Chain:  ${options.chain}`);
              if (result.estimatedFee) log(`  Fee:    ${result.estimatedFee}`);
              log('');
              return;
            }

            const result = await sendTokens(sendOpts);
            log(`\n✓ Transaction sent\n`);
            log(`  Tx Hash: ${result.transactionHash}`);
            log(`  Chain:   ${result.chain}`);
            log(`  From:    ${result.from}`);
            log(`  To:      ${result.to}`);
            log(`  Amount:  ${result.amount}`);
            log(`  Token:   ${result.token}`);
            if (result.blockNumber) log(`  Block:   ${result.blockNumber}`);
            log(`  Status:  ${result.confirmed ? 'confirmed' : 'pending'}`);
            log(`  Explorer: ${result.explorer}`);
            log('');
            return;
          } catch (err) {
            throw new CommandError(err.message, 'SEND_FAILED');
          }
        },

        'forget-password': async () => {
          const result = deletePassword();
          if (result.keychain || result.file) {
            log('✓ Password removed from:');
            if (result.keychain) log('  - System keychain');
            if (result.file) log('  - Credentials file (~/.nansen/wallets/.credentials)');
          } else {
            log('No saved password found (keychain or credentials file).');
          }
        },

        'secure': async () => {
          const { password, source } = retrievePassword();
          if (!password) {
            throw new CommandError('No wallet password found in any store.', 'NO_PASSWORD_FOUND', {
              error: 'NO_PASSWORD_FOUND',
              message: 'No wallet password found in any store.',
              resolution: [
                'Set NANSEN_WALLET_PASSWORD and run: nansen wallet secure',
                'This will store it in the OS keychain.',
              ],
            });
          }

          if (source === 'keychain') {
            log('✓ Password is already stored in the OS keychain (secure).');
            return;
          }

          // Verify password actually decrypts wallets before overwriting keychain
          const walletConfig = getWalletConfig();
          if (walletConfig.passwordHash && !verifyPassword(password, walletConfig)) {
            const resolution = source === 'file'
              ? [
                  'The password in ~/.nansen/wallets/.credentials is incorrect.',
                  'Run: nansen wallet forget-password  then re-run with the correct password: NANSEN_WALLET_PASSWORD=<pw> nansen wallet secure',
                ]
              : [
                  'Unset NANSEN_WALLET_PASSWORD if it is stale, then re-run: nansen wallet secure',
                ];
            throw new CommandError(`Password from '${source}' does not match the wallet's stored hash.`, 'INCORRECT_PASSWORD', {
              error: 'INCORRECT_PASSWORD',
              message: `Password from '${source}' does not match the wallet's stored hash.`,
              resolution,
            });
          }

          // Try to migrate to keychain
          const { stored, method } = storePassword(password);
          if (stored && method === 'keychain') {
            const fileRemoved = deleteCredentialsFile();
            const fromLabel = source === 'file'
              ? '~/.nansen/wallets/.credentials file'
              : 'NANSEN_WALLET_PASSWORD env var';
            log(`✓ Password migrated from ${fromLabel} → OS keychain (secure).`);
            if (fileRemoved) {
              log('  Removed ~/.nansen/wallets/.credentials.');
            }
          } else {
            const msg = source === 'file'
              ? 'OS keychain is not available. Password remains in ~/.nansen/wallets/.credentials (insecure).'
              : 'OS keychain is not available. Password is only in the NANSEN_WALLET_PASSWORD env var (not persisted).';
            throw new CommandError(msg, 'KEYCHAIN_UNAVAILABLE', {
              error: 'KEYCHAIN_UNAVAILABLE',
              message: msg,
              resolution: [
                'Set NANSEN_WALLET_PASSWORD in a secrets manager or system keyring',
                'Use a containerized secrets agent (e.g. Vault, 1Password CLI)',
              ],
            });
          }
        },

        'help': async () => {
          log(`
Wallet Management - EVM and Solana wallets (local or Privy server-side)

USAGE:
  nansen wallet <command> [options]

COMMANDS:
  create [--name <label>] [--provider <local|privy>] [--unsafe-no-password]
                             Create a new wallet pair (EVM + Solana)
  list                       List all wallets
  show <name>                Show wallet addresses
  export <name>              Export private keys (local wallets only, requires password)
  default <name>             Set the default wallet
  delete <name>              Delete a wallet
  send --to <address> --amount <number> --chain <evm|solana> [--token <address>] [--wallet <name>] [--max] [--dry-run]
                             Send tokens or native currency (--max sends entire balance, --dry-run previews without sending)
  forget-password            Remove saved password from all stores
  secure                     Migrate password from insecure storage to OS keychain

OPTIONS:
  --name <label>             Wallet name (default: "default")
  --provider <local|privy>   Wallet provider: "local" (default) stores encrypted keys on disk,
                             "privy" creates server-side wallets via Privy API
  --to <address>             Recipient address (required for send)
  --amount <number>          Amount to send in human-readable format (required unless --max)
  --chain <evm|solana>       Blockchain to use (required for send)
  --token <address>          Token contract/mint address (optional, sends native if omitted)
  --wallet <name>            Wallet to use (optional, uses default if omitted; use "walletconnect" or "wc" for WalletConnect, EVM only)
  --max                      Send entire balance (deducts gas for native transfers)
  --unsafe-no-password       Skip encryption — private keys stored UNENCRYPTED on disk (local only)
  --human                    Enable interactive prompts (for human terminal use only)

PASSWORD RESOLUTION (automatic, in order):
  1. NANSEN_WALLET_PASSWORD env var
  2. OS keychain (saved automatically on wallet create)
  3. Interactive prompt (only with --human flag)

ENVIRONMENT:
  NANSEN_WALLET_PASSWORD     Wallet encryption password
  PRIVY_APP_ID               Privy application ID (required for --provider privy)
  PRIVY_APP_SECRET           Privy application secret (required for --provider privy)
  NANSEN_WALLET_PROVIDER     Default provider for wallet create ("local" or "privy")
  NANSEN_EVM_RPC            Custom Ethereum RPC endpoint (also generic EVM fallback)
  NANSEN_BASE_RPC           Custom Base RPC endpoint
  NANSEN_SOLANA_RPC         Custom Solana RPC endpoint

EXAMPLES:
  NANSEN_WALLET_PASSWORD=mypass nansen wallet create --name trading
  nansen wallet create --name agent-wallet --provider privy
  nansen wallet list
  nansen wallet export trading
  nansen wallet default trading
  nansen wallet send --to 0x742d35Cc... --amount 1.5 --chain evm
  nansen wallet send --to 9WzDXw... --amount 0.1 --chain solana --token So11...
  nansen wallet forget-password
`);
          return;
        },
      };

      if (!handlers[subcommand]) {
        throw new CommandError(`Unknown subcommand: ${subcommand}. Available: ${Object.keys(handlers).join(', ')}`, 'UNKNOWN_COMMAND');
      }

      // --help on any wallet subcommand shows wallet help instead of executing
      if (flags.help || flags.h) {
        return handlers['help']();
      }

      return handlers[subcommand]();
    },
  };
}
