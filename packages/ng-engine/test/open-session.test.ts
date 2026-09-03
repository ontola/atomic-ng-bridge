import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSession } from '../src/worker/openSession.js';

/**
 * The worker's session path has to behave exactly like the page's, because the
 * defects it guards against are the ones that broke cross-session persistence
 * (`NEXTGRAPH-ISSUES.md` B4): reopening a held wallet by name rather
 * than re-importing it, and connecting to a broker at all. Wiring the worker up
 * without these would have reintroduced the bug on a path with no test
 * covering it.
 */

const opened = {
  V0: { wallet_id: 'w1', personal_site: 'site', client: undefined },
};

const session = {
  sessionId: 'sess',
  walletName: 'w1',
  userId: 'user-string',
  privateStoreId: 'did:ng:o:store',
  opened,
};

vi.mock('../src/session.js', () => ({
  openSavedWallet: vi.fn(() => Promise.resolve(session)),
  openWalletAndStartSession: vi.fn(() => Promise.resolve(session)),
  createWalletFromInvitation: vi.fn(() =>
    Promise.resolve({ session, opened, walletName: 'w1' }),
  ),
  connectUser: vi.fn(() => Promise.resolve({ server_ip: 'ws://broker' })),
}));

vi.mock('../src/identity.js', () => ({
  deriveAtomicPrivateKey: vi.fn(() => Promise.resolve('derived-key')),
}));

const wasm = {
  wallet_get_file: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
} as never;

const sessionModule = await import('../src/session.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('opening a session inside the worker', () => {
  it('opens a held wallet by name, and never re-imports it', async () => {
    const { result } = await openSession(wasm, {
      kind: 'saved',
      password: 'pw',
      walletName: 'w1',
    });

    expect(sessionModule.openSavedWallet).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'pw', walletName: 'w1' }),
    );
    expect(sessionModule.openWalletAndStartSession).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.walletFile).toBeUndefined();
  });

  it('connects to the broker, because that is what restores the stores', async () => {
    const { result } = await openSession(wasm, {
      kind: 'saved',
      password: 'pw',
      location: 'https://app.example/',
    });

    expect(sessionModule.connectUser).toHaveBeenCalledWith(
      wasm,
      session,
      'https://app.example/',
    );
    expect(result.connection).toEqual({ server_ip: 'ws://broker' });
  });

  it('still returns a session when no broker will have it', async () => {
    vi.mocked(sessionModule.connectUser).mockRejectedValueOnce(
      new Error('Closing'),
    );

    // Degraded, not broken: the Atomic side is durable on its own, so refusing
    // to hand back the session would take the whole app down with the mirror.
    const { result } = await openSession(wasm, { kind: 'saved', password: 'pw' });

    expect(result.connection).toBeUndefined();
    expect(result.walletName).toBe('w1');
  });

  it('persists a remembered wallet when told to, so later loads open it by name', async () => {
    // `wallet_create` does not put a new wallet in the local broker's list
    // (`local_save: false`), so the load after a creation cannot open it by
    // name — it has to come through the file, and that import is what persists
    // it. Getting this wrong wired the worker up to fail on every second load.
    await openSession(wasm, {
      kind: 'wallet-file',
      walletFile: new Uint8Array([9]),
      password: 'pw',
      inMemory: false,
    });

    expect(sessionModule.openWalletAndStartSession).toHaveBeenCalledWith(
      expect.objectContaining({ inMemory: false }),
    );
  });

  it('leaves nothing behind for a wallet the user brought', async () => {
    await openSession(wasm, {
      kind: 'wallet-file',
      walletFile: new Uint8Array([9]),
      password: 'pw',
    });

    expect(sessionModule.openWalletAndStartSession).toHaveBeenCalledWith(
      expect.objectContaining({ inMemory: true }),
    );
  });

  it('hands back the new wallet bytes on creation, so the page can save them', async () => {
    const { result } = await openSession(wasm, {
      kind: 'create',
      bootstrap: {},
      password: 'pw',
    });

    expect(result.created).toBe(true);
    expect(result.walletFile).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('creates a session even if the wallet cannot be exported', async () => {
    const failing = {
      wallet_get_file: vi.fn(() => Promise.reject(new Error('nope'))),
    } as never;

    const { result } = await openSession(failing, {
      kind: 'create',
      bootstrap: {},
      password: 'pw',
    });

    expect(result.created).toBe(true);
    expect(result.walletFile).toBeUndefined();
  });

  it('hands the page the derived key and never the wallet', async () => {
    const { result } = await openSession(wasm, { kind: 'saved', password: 'pw' });

    expect(result.atomicPrivateKey).toBe('derived-key');
    expect(Object.keys(result)).not.toContain('opened');
  });
});
