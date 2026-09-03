/**
 * Keeping the same wallet across reloads.
 *
 * Without this the mirror creates a fresh throwaway wallet on every page load,
 * which means a new NextGraph identity, a new document, and no continuity —
 * fine for proving the plumbing works, useless as a product.
 *
 * The encrypted wallet file goes in IndexedDB. It is exactly the `.ngw` a user
 * would otherwise hold, and it is encrypted with the wallet's own password, so
 * what is stored here is not usable on its own.
 *
 * **The password is the honest weak point.** For a wallet this code generated,
 * we keep the generated password in `localStorage`, which makes the whole thing
 * device-local convenience rather than a secret the user manages — the point is
 * that they manage *no* second secret, and their real wallet is the identity.
 * A deployment where the user brings their own wallet should never store its
 * password: unlock per session, or wrap it with a passkey (WebAuthn PRF) so the
 * unlock is biometric and the password is never typed or written down.
 */

import type { PasskeyRecord } from './passkey.js';

const DB_NAME = 'atomic-ng-bridge-wallet';
const STORE = 'wallet';
const KEY = 'current';
const PASSKEY_KEY = 'passkey';
const PASSWORD_KEY = 'atomic.ngBridge.password';

export type StoredWallet = {
  /** The encrypted wallet, as `wallet_get_file` returns it. */
  file: Uint8Array;
  walletName: string;
  savedAt: number;
};

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadWallet(): Promise<StoredWallet | undefined> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');

    return (await request(tx.objectStore(STORE).get(KEY))) as
      | StoredWallet
      | undefined;
  } catch {
    // Storage can be unavailable (private mode, blocked site data). Then every
    // load starts a fresh wallet, which is the old behaviour, not a failure.
    return undefined;
  }
}

export async function saveWallet(wallet: StoredWallet): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    await request(tx.objectStore(STORE).put(wallet, KEY));
  } catch {
    // Same: not being able to remember the wallet costs continuity, not data.
  }
}

export async function forgetWallet(): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    await request(tx.objectStore(STORE).delete(KEY));
    await request(tx.objectStore(STORE).delete(PASSKEY_KEY));
    localStorage.removeItem(PASSWORD_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** The passkey-wrapped password, when one has been set up. */
export async function loadPasskeyRecord(): Promise<PasskeyRecord | undefined> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');

    return (await request(tx.objectStore(STORE).get(PASSKEY_KEY))) as
      | PasskeyRecord
      | undefined;
  } catch {
    return undefined;
  }
}

export async function savePasskeyRecord(record: PasskeyRecord): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  await request(tx.objectStore(STORE).put(record, PASSKEY_KEY));
}

/**
 * Removes the plaintext password from localStorage.
 *
 * Called once a passkey holds it instead. Deliberately separate from saving the
 * record: the password must not be dropped until the wrapped copy is safely
 * stored, or an interrupted upgrade locks the user out of their own wallet.
 */
export function forgetPlaintextPassword(): void {
  localStorage.removeItem(PASSWORD_KEY);
}

/** Whether the password is still sitting in localStorage. */
export function hasPlaintextPassword(): boolean {
  return localStorage.getItem(PASSWORD_KEY) !== null;
}

/**
 * The password for a wallet this code generated. Created once per browser.
 *
 * Written to localStorage only until a passkey takes over (`upgradeToPasskey`);
 * see the file comment for why that is a stopgap and not a model.
 */
export function generatedPassword(): string {
  const existing = localStorage.getItem(PASSWORD_KEY);

  if (existing !== null) {
    return existing;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const generated = btoa(String.fromCharCode(...bytes));
  localStorage.setItem(PASSWORD_KEY, generated);

  return generated;
}
