/**
 * Where the wallet password comes from, in order of preference.
 *
 * 1. A passkey, if one has been set up. Nothing is stored in the clear and the
 *    user authenticates with a fingerprint. This is the destination.
 * 2. A generated password in localStorage. Works with no authenticator and no
 *    user interaction, which is what lets the mirror start on page load — but
 *    it is a secret sitting in plain sight, so it is a stopgap.
 *
 * The upgrade from 2 to 1 is deliberately a separate, user-initiated step:
 * WebAuthn needs a user gesture, and silently prompting for a fingerprint on
 * page load would be both broken and rude.
 */

import {
  createPasskey,
  passkeysAvailable,
  unwrapPassword,
  wrapPassword,
  PasskeyUnsupportedError,
} from './passkey.js';
import {
  forgetPlaintextPassword,
  generatedPassword,
  hasPlaintextPassword,
  loadPasskeyRecord,
  savePasskeyRecord,
} from './walletStorage.js';

export type PasswordSource = 'passkey' | 'local-storage' | 'none';

/** What protects the wallet right now, for the UI to report and act on. */
export async function passwordSource(): Promise<PasswordSource> {
  if ((await loadPasskeyRecord()) !== undefined) {
    return 'passkey';
  }

  return hasPlaintextPassword() ? 'local-storage' : 'none';
}

/**
 * The wallet password.
 *
 * With a passkey configured this prompts the authenticator, so it must be
 * called from a user gesture. Without one it returns the generated password and
 * prompts nothing.
 */
export async function walletPassword(): Promise<string> {
  const record = await loadPasskeyRecord();

  if (record !== undefined) {
    return unwrapPassword(record);
  }

  return generatedPassword();
}

export type UpgradeResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'no-prf' | 'failed'; message: string };

/**
 * Moves the current password into a passkey, then removes the plaintext copy.
 *
 * Must be called from a user gesture. The order matters: the wrapped copy is
 * saved *before* the plaintext one is dropped, so an interruption at any point
 * leaves the wallet openable rather than lost.
 */
export async function upgradeToPasskey(
  label = 'NextGraph wallet',
): Promise<UpgradeResult> {
  if (!(await passkeysAvailable())) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'This device has no platform authenticator.',
    };
  }

  const password = generatedPassword();

  try {
    const { credentialId, prfSupported } = await createPasskey(label);

    if (!prfSupported) {
      // The passkey exists but cannot hold a secret for us. Leaving the
      // password where it is beats pretending this worked.
      return {
        ok: false,
        reason: 'no-prf',
        message:
          'This authenticator does not support the PRF extension, so it cannot hold the wallet password.',
      };
    }

    const record = await wrapPassword(credentialId, password);
    await savePasskeyRecord(record);
    forgetPlaintextPassword();

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message:
        error instanceof PasskeyUnsupportedError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}
