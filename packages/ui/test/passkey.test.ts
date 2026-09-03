import { describe, expect, it } from 'vitest';
import { fromB64Url, toB64Url } from '../src/passkey.js';

/**
 * WebAuthn itself needs an authenticator, so the parts worth unit-testing are
 * the ones that would corrupt a wallet password silently: the encoding used for
 * every stored field of a `PasskeyRecord`. A round-trip that drops a byte turns
 * into "your wallet cannot be opened" much later, with no clue why.
 */
describe('base64url round trip', () => {
  it('survives every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);

    expect(fromB64Url(toB64Url(all))).toEqual(all);
  });

  it('handles every length remainder, where padding rules differ', () => {
    for (const length of [1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 7 + 3) % 256);

      expect(fromB64Url(toB64Url(bytes))).toEqual(bytes);
    }
  });

  it('emits url-safe, unpadded output', () => {
    const encoded = toB64Url(Uint8Array.from([251, 255, 190, 0, 16]));

    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('round trips the shapes a record actually stores', () => {
    // 32-byte PRF salt, 12-byte AES-GCM iv, and a wrapped password (plaintext
    // length plus a 16-byte tag).
    for (const length of [32, 12, 24 + 16]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));

      expect(fromB64Url(toB64Url(bytes))).toEqual(bytes);
    }
  });
});
