import { describe, expect, it, vi } from 'vitest';
import { openSavedWallet, openWalletAndStartSession } from '../src/index.js';

const OPENED = {
  V0: { wallet_id: 'w1', personal_site: 'user-1', client: undefined },
};

const sessionResponse = {
  session_id: 'sess',
  private_store_id: 'did:ng:o:store',
  user: 'user-string',
};

const wasm = (overrides: Record<string, unknown> = {}) =>
  ({
    wallet_read_file: vi.fn(() => Promise.resolve('encrypted')),
    wallet_open_with_password: vi.fn(() => Promise.resolve(structuredClone(OPENED))),
    wallet_was_opened: vi.fn(() => Promise.resolve('client')),
    wallet_import: vi.fn(() => Promise.resolve('client')),
    wallets_reload: vi.fn(() => Promise.resolve(undefined)),
    get_wallets: vi.fn(() => Promise.resolve({})),
    session_start: vi.fn(() => Promise.resolve(sessionResponse)),
    session_in_memory_start: vi.fn(() => Promise.resolve(sessionResponse)),
    ...overrides,
  }) as never;

/**
 * `wallet_read_file` refuses a wallet the local broker already holds, which is
 * the normal state for a returning user. Reading that as a broken wallet is
 * what made the bridge fork the user's identity on every reload.
 */
describe('opening a wallet the browser has seen before', () => {
  it('opens the held wallet by name when the file is refused as already added', async () => {
    const ng = wasm({
      wallet_read_file: vi.fn(() => Promise.reject(new Error('WalletAlreadyAdded'))),
      get_wallets: vi.fn(() => Promise.resolve({ w1: { wallet: 'held' } })),
    });

    const session = await openWalletAndStartSession({
      ng,
      walletFile: new Uint8Array(),
      password: 'pw',
      walletName: 'w1',
      inMemory: false,
    });

    expect(session.walletName).toBe('w1');
    expect(session.sessionId).toBe('sess');
    // `user_connect` takes the string form, not the wallet's PubKey object:
    // handing it the object aborts the wasm, so nothing ever reaches a broker.
    expect(session.userId).toBe('user-string');
    // The whole point: no second wallet is created or imported.
    expect((ng as { wallet_import: ReturnType<typeof vi.fn> }).wallet_import).not.toHaveBeenCalled();
    expect(
      (ng as { wallet_open_with_password: ReturnType<typeof vi.fn> })
        .wallet_open_with_password,
    ).toHaveBeenCalledWith('held', 'pw');
  });

  it('imports normally when the browser has never seen the wallet', async () => {
    const ng = wasm();

    await openWalletAndStartSession({
      ng,
      walletFile: new Uint8Array(),
      password: 'pw',
    });

    expect((ng as { wallet_import: ReturnType<typeof vi.fn> }).wallet_import).toHaveBeenCalled();
  });

  it('names the failing step, since every call reports the same kind of string', async () => {
    const ng = wasm({
      wallet_open_with_password: vi.fn(() => Promise.reject(new Error('InvalidPazzle'))),
    });

    await expect(
      openWalletAndStartSession({ ng, walletFile: new Uint8Array(), password: 'nope' }),
    ).rejects.toThrow('wallet_open_with_password failed: InvalidPazzle');
  });

  it('picks the named wallet when the browser holds several', async () => {
    const ng = wasm({
      get_wallets: vi.fn(() =>
        Promise.resolve({ other: { wallet: 'x' }, w1: { wallet: 'held' } }),
      ),
    });

    const session = await openSavedWallet({ ng, password: 'pw', walletName: 'w1' });

    expect(session.walletName).toBe('w1');
  });

  it('reads the Map the wasm actually returns, not just a plain object', async () => {
    const ng = wasm({
      get_wallets: vi.fn(() => Promise.resolve(new Map([['w1', { wallet: 'held' }]]))),
    });

    // `get_wallets` serializes a Rust HashMap, which arrives as a JS Map.
    // Reading it with `Object.keys` finds nothing and starts a new identity.
    expect((await openSavedWallet({ ng, password: 'pw' })).walletName).toBe('w1');
  });

  it('says so when there is no saved wallet to open', async () => {
    await expect(openSavedWallet({ ng: wasm(), password: 'pw' })).rejects.toThrow(
      'No saved NextGraph wallet',
    );
  });
});
