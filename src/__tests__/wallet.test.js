/**
 * Tests for wallet module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { vi } from 'vitest';
import {
  base58Encode,
  encryptKey,
  decryptKey,
  generateEvmWallet,
  generateSolanaWallet,
  createWallet,
  listWallets,
  showWallet,
  exportWallet,
  setDefaultWallet,
  deleteWallet,
  getWalletConfig,
} from '../wallet.js';
import { keccak256 } from '../crypto.js';

// Override HOME to use temp dir for tests
let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-wallet-test-'));
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('keccak256', () => {
  it('should hash empty input correctly', () => {
    const hash = keccak256(Buffer.alloc(0));
    expect(hash.toString('hex')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('should hash "hello" correctly', () => {
    const hash = keccak256(Buffer.from('hello'));
    expect(hash.toString('hex')).toBe(
      '1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8'
    );
  });

  // Keccak256("transfer(address,uint256)") — the ERC-20 transfer selector
  // First 4 bytes should be 0xa9059cbb (universally known in Ethereum)
  it('should produce correct ERC-20 transfer selector', () => {
    const hash = keccak256(Buffer.from('transfer(address,uint256)'));
    expect(hash.toString('hex').slice(0, 8)).toBe('a9059cbb');
  });
});

describe('base58Encode', () => {
  it('should encode simple buffer', () => {
    const encoded = base58Encode(Buffer.from([0, 0, 1]));
    expect(encoded).toBe('112');
  });

  it('should handle leading zeros', () => {
    const encoded = base58Encode(Buffer.from([0, 0, 0]));
    expect(encoded).toBe('111');
  });
});

describe('encryption', () => {
  it('should encrypt and decrypt a key', () => {
    const key = 'a'.repeat(64); // 32 bytes as hex
    const password = 'testpassword123';

    const encrypted = encryptKey(key, password);
    expect(encrypted.cipher).toBe('aes-256-gcm');
    expect(encrypted.kdf).toBe('scrypt');

    const decrypted = decryptKey(encrypted, password);
    expect(decrypted).toBe(key);
  });

  it('should fail with wrong password', () => {
    const key = 'b'.repeat(64);
    const encrypted = encryptKey(key, 'correct-password');

    expect(() => decryptKey(encrypted, 'wrong-password')).toThrow('Incorrect password');
  });
});

describe('generateEvmWallet', () => {
  it('should generate valid EVM wallet', () => {
    const wallet = generateEvmWallet();
    expect(wallet.privateKey).toHaveLength(64); // 32 bytes hex
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('should generate unique wallets', () => {
    const w1 = generateEvmWallet();
    const w2 = generateEvmWallet();
    expect(w1.address).not.toBe(w2.address);
    expect(w1.privateKey).not.toBe(w2.privateKey);
  });

  it('should derive correct address from known private key', () => {
    // Well-known test vector (used in Ethereum docs and ethers.js tests):
    // Private key: 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    // Expected address: 0xFCAd0B19bB29D4674531d6f115237E16AfCE377c (checksummed)
    //
    // We can't call generateEvmWallet with a specific key, so test the
    // underlying keccak + address derivation directly:
    
    const privKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privKey);
    const pubKey = ecdh.getPublicKey(null, 'uncompressed');
    const hash = keccak256(pubKey.subarray(1));
    const addr = '0x' + hash.subarray(12).toString('hex');
    expect(addr.toLowerCase()).toBe('0xfcad0b19bb29d4674531d6f115237e16afce377c');
  });
});

describe('generateSolanaWallet', () => {
  it('should generate valid Solana wallet', () => {
    const wallet = generateSolanaWallet();
    expect(wallet.privateKey).toHaveLength(128); // 64 bytes hex (seed + pubkey)
    expect(wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/); // base58
    expect(wallet.address.length).toBeGreaterThanOrEqual(32);
    expect(wallet.address.length).toBeLessThanOrEqual(44);
  });
});

describe('Solana keypair integrity', () => {
  it('should produce a keypair where signing with private key verifies with public key', async () => {
    
    const wallet = generateSolanaWallet();
    const keypairHex = wallet.privateKey; // 64 bytes: seed (32) + pubkey (32)
    const seed = Buffer.from(keypairHex.slice(0, 64), 'hex'); // first 32 bytes
    const pubBytes = Buffer.from(keypairHex.slice(64), 'hex'); // last 32 bytes

    // Re-derive public key from seed and verify it matches
    const keyObj = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
        seed,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const msg = Buffer.from('nansen-test-message');
    const sig = crypto.sign(null, msg, keyObj);

    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), // SPKI Ed25519 prefix
        pubBytes,
      ]),
      format: 'der',
      type: 'spki',
    });
    const valid = crypto.verify(null, msg, pubKeyObj, sig);
    expect(valid).toBe(true);
  });

  it('should produce base58 address matching the public key bytes', () => {
    const wallet = generateSolanaWallet();
    const pubBytes = Buffer.from(wallet.privateKey.slice(64), 'hex');
    const reEncoded = base58Encode(pubBytes);
    expect(reEncoded).toBe(wallet.address);
  });
});

describe('wallet CRUD', () => {
  const PASSWORD = 'test-password-123!!';

  it('should create a wallet', () => {
    const result = createWallet('my-wallet', PASSWORD);
    expect(result.name).toBe('my-wallet');
    expect(result.evm).toMatch(/^0x/);
    expect(result.solana).toBeTruthy();
    expect(result.isDefault).toBe(true);
  });

  it('should list wallets', () => {
    createWallet('w1', PASSWORD);
    createWallet('w2', PASSWORD);
    const result = listWallets();
    expect(result.wallets).toHaveLength(2);
    expect(result.defaultWallet).toBe('w1');
  });

  it('should show a wallet', () => {
    createWallet('show-test', PASSWORD);
    const result = showWallet('show-test');
    expect(result.name).toBe('show-test');
    expect(result.evm).toMatch(/^0x/);
  });

  it('should export private keys with correct password', () => {
    createWallet('export-test', PASSWORD);
    const result = exportWallet('export-test', PASSWORD);
    expect(result.evm.privateKey).toHaveLength(64);
    expect(result.solana.privateKey).toHaveLength(128);
  });

  it('should reject export with wrong password', () => {
    createWallet('export-fail', PASSWORD);
    expect(() => exportWallet('export-fail', 'wrong')).toThrow('Incorrect password');
  });

  it('should set default wallet', () => {
    createWallet('first', PASSWORD);
    createWallet('second', PASSWORD);
    const result = setDefaultWallet('second');
    expect(result.defaultWallet).toBe('second');
  });

  it('should delete a wallet', async () => {
    createWallet('to-delete', PASSWORD);
    const result = await deleteWallet('to-delete', PASSWORD);
    expect(result.deleted).toBe('to-delete');
    expect(listWallets().wallets).toHaveLength(0);
  });

  it('should reject path traversal in wallet names', () => {
    expect(() => createWallet('../../etc/evil', PASSWORD)).toThrow('Wallet name must be');
    expect(() => createWallet('foo/bar', PASSWORD)).toThrow('Wallet name must be');
    expect(() => createWallet('', PASSWORD)).toThrow('Wallet name must be');
    expect(() => createWallet('.hidden', PASSWORD)).toThrow('Wallet name must be');
  });

  it('should reject duplicate wallet names', () => {
    createWallet('dupe', PASSWORD);
    expect(() => createWallet('dupe', PASSWORD)).toThrow('already exists');
  });

  it('should reject wrong password on create (second wallet)', () => {
    createWallet('first-wallet', PASSWORD);
    expect(() => createWallet('second-wallet', 'wrong-password')).toThrow('Incorrect password');
  });

  it('should round-trip: create wallet, export keys, derive same addresses', async () => {
    
    const result = createWallet('roundtrip', PASSWORD);
    const exported = exportWallet('roundtrip', PASSWORD);

    // Verify EVM: private key → address
    const privKey = Buffer.from(exported.evm.privateKey, 'hex');
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privKey);
    const pubKey = ecdh.getPublicKey(null, 'uncompressed');
    
    const hash = keccak256(pubKey.subarray(1));
    const derivedAddr = '0x' + hash.subarray(12).toString('hex');
    expect(derivedAddr.toLowerCase()).toBe(result.evm.toLowerCase());

    // Verify Solana: keypair pubkey bytes → base58 address
    const solPub = Buffer.from(exported.solana.privateKey.slice(64), 'hex');
    
    expect(base58Encode(solPub)).toBe(result.solana);
  });

  it('should update default after deleting default wallet', async () => {
    createWallet('a', PASSWORD);
    createWallet('b', PASSWORD);
    setDefaultWallet('a');
    await deleteWallet('a', PASSWORD);
    const list = listWallets();
    expect(list.defaultWallet).toBe('b');
  });

  it('should clear passwordHash when last wallet is deleted', () => {
    createWallet('only', PASSWORD);
    deleteWallet('only', PASSWORD);
    const config = getWalletConfig();
    expect(config.passwordHash).toBeNull();
  });

  it('should allow new password after deleting all wallets', () => {
    createWallet('old', PASSWORD);
    deleteWallet('old', PASSWORD);
    const NEW_PASSWORD = 'completely-different-password';
    const result = createWallet('fresh', NEW_PASSWORD);
    expect(result.evm).toBeDefined();
    const exported = exportWallet('fresh', NEW_PASSWORD);
    expect(exported.evm.privateKey).toBeTruthy();
  });
});

describe('passwordless encryption', () => {
  it('encryptKey with null password returns plaintext wrapper', () => {
    const key = 'a'.repeat(64);
    const result = encryptKey(key, null);
    expect(result).toEqual({ data: key, encrypted: false });
  });

  it('decryptKey with unencrypted blob returns data', () => {
    const key = 'b'.repeat(64);
    const blob = { data: key, encrypted: false };
    expect(decryptKey(blob, null)).toBe(key);
    // Password is ignored for unencrypted blobs
    expect(decryptKey(blob, 'any-password')).toBe(key);
  });

  it('decryptKey throws on encrypted blob with null password', () => {
    const key = 'c'.repeat(64);
    const encrypted = encryptKey(key, 'test-password-123');
    expect(() => decryptKey(encrypted, null)).toThrow('Wallet is encrypted');
  });

  it('decryptKey throws on tampered unencrypted blob (has encryption fields)', () => {
    const blob = { data: 'x'.repeat(64), encrypted: false, salt: 'deadbeef' };
    expect(() => decryptKey(blob, null)).toThrow('corrupted or tampered');
  });

  it('decryptKey throws on encrypted blob missing required fields', () => {
    const blob = { salt: 'deadbeef' };
    expect(() => decryptKey(blob, 'some-password')).toThrow('corrupted or tampered');
  });
});

describe('passwordless wallet CRUD', () => {
  it('should create, export, and delete a passwordless wallet', async () => {
    const result = createWallet('nopass', null);
    expect(result.name).toBe('nopass');
    expect(result.evm).toMatch(/^0x/);
    expect(result.solana).toBeTruthy();

    // Config should have no passwordHash
    const config = getWalletConfig();
    expect(config.passwordHash).toBeNull();

    // Export without password
    const exported = exportWallet('nopass', null);
    expect(exported.evm.privateKey).toHaveLength(64);
    expect(exported.solana.privateKey).toHaveLength(128);

    // Delete without password
    const deleted = await deleteWallet('nopass', null);
    expect(deleted.deleted).toBe('nopass');
  });

  it('should reject --unsafe-no-password when passwordHash exists', () => {
    createWallet('encrypted-first', 'test-password-123!!');
    expect(() => createWallet('nopass-second', null)).toThrow(
      'Existing wallets are password-protected'
    );
  });

  it('should allow multiple passwordless wallets', () => {
    createWallet('a', null);
    createWallet('b', null);
    const list = listWallets();
    expect(list.wallets).toHaveLength(2);
  });

  it('should not prompt for password on delete when passwordHash is null', async () => {
    createWallet('nopass-del', null);
    const promptFn = vi.fn();
    const logs = [];
    const { buildWalletCommands } = await import('../wallet.js');
    const cmds = buildWalletCommands({ log: (m) => logs.push(m), promptFn, exit: () => {} });
    await cmds.wallet(['delete'], null, {}, { name: 'nopass-del' });
    expect(promptFn).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('deleted'))).toBe(true);
  });

  it('should not prompt for password on send when passwordHash is null', async () => {
    createWallet('nopass-send', null);
    const promptFn = vi.fn();
    const logs = [];
    const { buildWalletCommands } = await import('../wallet.js');
    const cmds = buildWalletCommands({ log: (m) => logs.push(m), promptFn, exit: () => {} });
    // Send will throw CommandError (no RPC mocks), but the point is promptFn was never called
    await cmds.wallet(['send'], null, { 'dry-run': true }, {
      to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      amount: '0.01',
      chain: 'base',
      wallet: 'nopass-send',
    }).catch(() => {});
    expect(promptFn).not.toHaveBeenCalled();
  });

  it('should reject encrypted wallet when passwordless wallets exist', () => {
    createWallet('nopass-first', null);
    expect(() => createWallet('encrypted-second', 'test-password-123!!')).toThrow(
      'Existing wallets are passwordless'
    );
  });

  it('should allow encrypted wallet when only Privy wallets exist', () => {
    // Write a Privy wallet reference (no private keys)
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletsDir, 'privy-only.json'),
      JSON.stringify({ provider: 'privy', evm: { address: '0xabc' }, solana: { address: 'abc' } })
    );
    // Creating an encrypted local wallet should succeed
    expect(() => createWallet('encrypted-after-privy', 'test-password-123!!')).not.toThrow();
  });
});

describe('Privy wallet files', () => {
  it('showWallet reads a Privy wallet reference file', () => {
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletsDir, 'my-privy.json'),
      JSON.stringify({
        name: 'my-privy',
        provider: 'privy',
        evm: { privyWalletId: 'wl_evm_1', address: '0xPrivyEvm' },
        solana: { privyWalletId: 'wl_sol_1', address: 'PrivySolAddr' },
        createdAt: '2026-01-01T00:00:00Z',
      })
    );
    fs.writeFileSync(
      path.join(walletsDir, 'config.json'),
      JSON.stringify({ defaultWallet: 'my-privy', passwordHash: null })
    );

    const result = showWallet('my-privy');
    expect(result.name).toBe('my-privy');
    expect(result.provider).toBe('privy');
    expect(result.evm).toBe('0xPrivyEvm');
    expect(result.solana).toBe('PrivySolAddr');
    expect(result.privyWalletIds.evm).toBe('wl_evm_1');
    expect(result.privyWalletIds.solana).toBe('wl_sol_1');
  });

  it('showWallet returns provider local for local wallets', () => {
    createWallet('local-test', 'testpassword12');
    const result = showWallet('local-test');
    expect(result.provider).toBe('local');
    expect(result.privyWalletIds).toBeUndefined();
  });

  it('listWallets includes both local and Privy wallets', () => {
    createWallet('local-one', 'testpassword12');

    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.writeFileSync(
      path.join(walletsDir, 'privy-one.json'),
      JSON.stringify({
        name: 'privy-one',
        provider: 'privy',
        evm: { privyWalletId: 'wl_1', address: '0xAddr' },
        solana: { privyWalletId: 'wl_2', address: 'SolAddr' },
        createdAt: '2026-01-01T00:00:00Z',
      })
    );

    const result = listWallets();
    expect(result.wallets).toHaveLength(2);
    const names = result.wallets.map((w) => w.name);
    expect(names).toContain('local-one');
    expect(names).toContain('privy-one');

    const privy = result.wallets.find((w) => w.name === 'privy-one');
    expect(privy.provider).toBe('privy');
    expect(privy.evm).toBe('0xAddr');
  });

});

describe('Privy wallet create via unified flow', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('cleans up EVM wallet if Solana wallet creation fails', async () => {
    const { createPrivyWalletPair } = await import('../privy.js');

    const deleteCalls = [];
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      // Track delete calls
      if (opts?.method === 'DELETE') {
        deleteCalls.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      callCount++;
      if (callCount === 1) {
        // EVM wallet creation succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'wl_evm_orphan', address: '0xOrphan', chain_type: 'ethereum' }),
        });
      }
      // Solana wallet creation fails
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'internal_error', message: 'Solana create failed' }),
      });
    }));

    await expect(createPrivyWalletPair('orphan-test')).rejects.toThrow();

    // Should have attempted to delete the orphaned EVM wallet
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]).toContain('wl_evm_orphan');

    // No local file should exist
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    const walletFile = path.join(walletsDir, 'orphan-test.json');
    expect(fs.existsSync(walletFile)).toBe(false);
  });

  it('creates both EVM + Solana Privy wallets and stores reference file', async () => {
    const { createPrivyWalletPair } = await import('../privy.js');

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'wl_evm_1', address: '0xEvmAddr', chain_type: 'ethereum',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 'wl_sol_1', address: 'SolAddr', chain_type: 'solana',
        }),
      });
    }));

    const result = await createPrivyWalletPair('my-privy-wallet');

    expect(result.name).toBe('my-privy-wallet');
    expect(result.evm.address).toBe('0xEvmAddr');
    expect(result.evm.privyWalletId).toBe('wl_evm_1');
    expect(result.solana.address).toBe('SolAddr');
    expect(result.solana.privyWalletId).toBe('wl_sol_1');

    const wallet = showWallet('my-privy-wallet');
    expect(wallet.provider).toBe('privy');
    expect(wallet.evm).toBe('0xEvmAddr');
    expect(wallet.solana).toBe('SolAddr');
  });
});

describe('Privy wallet delete and export', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';

    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletsDir, 'privy-del.json'),
      JSON.stringify({
        name: 'privy-del',
        provider: 'privy',
        evm: { privyWalletId: 'wl_evm_1', address: '0xAddr' },
        solana: { privyWalletId: 'wl_sol_1', address: 'SolAddr' },
        createdAt: '2026-01-01T00:00:00Z',
      })
    );
    fs.writeFileSync(
      path.join(walletsDir, 'config.json'),
      JSON.stringify({ defaultWallet: 'privy-del', passwordHash: null })
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('deleteWallet removes local reference for Privy wallets', async () => {
    const result = await deleteWallet('privy-del');
    expect(result.deleted).toBe('privy-del');
    expect(() => showWallet('privy-del')).toThrow(/not found/);
  });

  it('exportWallet throws for non-local wallets', () => {
    expect(() => exportWallet('privy-del', 'any')).toThrow(/managed by the provider/);
  });
});

describe('Privy wallet create does not emit PASSWORD_REQUIRED', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not show PASSWORD_REQUIRED when --provider privy and privy creation fails', async () => {
    // Mock privy.js to throw (simulates missing env vars)
    vi.doMock('../privy.js', () => ({
      createPrivyWalletPair: vi.fn().mockRejectedValue(
        new Error('Privy credentials required. Set PRIVY_APP_ID and PRIVY_APP_SECRET environment variables.')
      ),
    }));

    const { buildWalletCommands } = await import('../wallet.js');
    const output = [];
    const cmds = buildWalletCommands({
      log: (m) => output.push(m),
    });

    const err = await cmds.wallet(['create'], null, {}, { provider: 'privy' }).catch(e => e);

    expect(err.message).toContain('Privy credentials required');
    expect(err.message).not.toContain('PASSWORD_REQUIRED');
    expect(output.join('\n')).not.toContain('PASSWORD_REQUIRED');
  });
});

describe('Wallet list/show CLI output for provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list output shows provider for Privy wallets', async () => {
    const walletsDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(path.join(walletsDir, 'config.json'),
      JSON.stringify({ defaultWallet: 'pv', passwordHash: null }));
    fs.writeFileSync(path.join(walletsDir, 'pv.json'),
      JSON.stringify({
        name: 'pv', provider: 'privy',
        evm: { privyWalletId: 'wl_1', address: '0xAddr' },
        solana: { privyWalletId: 'wl_2', address: 'SolAddr' },
        createdAt: '2026-01-01T00:00:00Z',
      }));

    const { buildWalletCommands } = await import('../wallet.js');
    const output = [];
    const cmds = buildWalletCommands({ log: (m) => output.push(m), exit: () => {} });
    await cmds.wallet(['list'], null, {}, {});

    const joined = output.join('\n');
    expect(joined).toContain('privy');
  });
});
