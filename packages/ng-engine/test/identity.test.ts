import { describe, expect, it } from 'vitest';
import {
  NoWalletKeyMaterialError,
  deriveAgentSeed,
  deriveAtomicPrivateKey,
  encodeB64Url,
  walletKeyMaterial,
  type OpenedWalletV0,
} from '../src/index.js';

const wallet = (V0: Partial<OpenedWalletV0['V0']>): OpenedWalletV0 =>
  ({
    V0: {
      wallet_id: 'wallet-1',
      personal_site: 'site-1',
      ...V0,
    },
  }) as OpenedWalletV0;

const material = Array.from({ length: 32 }, (_, i) => i + 1);

describe('finding the wallet key material', () => {
  it('prefers the master key', () => {
    expect(
      walletKeyMaterial(
        wallet({ master_key: material, wallet_privkey: { Ed25519PrivKey: [9] } }),
      ),
    ).toEqual(Uint8Array.from(material));
  });

  it('falls back to the wallet private key, unwrapping its tagged enum', () => {
    expect(
      walletKeyMaterial(wallet({ wallet_privkey: { Ed25519PrivKey: material } })),
    ).toEqual(Uint8Array.from(material));
  });

  it('accepts a bare array private key', () => {
    expect(walletKeyMaterial(wallet({ wallet_privkey: material }))).toEqual(
      Uint8Array.from(material),
    );
  });

  it('refuses to invent an identity when the wallet exposes nothing', () => {
    expect(() => walletKeyMaterial(wallet({}))).toThrow(
      NoWalletKeyMaterialError,
    );
    expect(() => walletKeyMaterial(wallet({ master_key: [] }))).toThrow(
      NoWalletKeyMaterialError,
    );
  });
});

describe('deriving the Atomic identity', () => {
  const bytes = Uint8Array.from(material);

  it('is deterministic: same wallet, same key, every device', async () => {
    const a = await deriveAgentSeed(bytes, 'wallet-1');
    const b = await deriveAgentSeed(bytes, 'wallet-1');

    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
  });

  it('separates wallets by id, so two wallets never share an identity', async () => {
    const a = await deriveAgentSeed(bytes, 'wallet-1');
    const b = await deriveAgentSeed(bytes, 'wallet-2');

    expect(a).not.toEqual(b);
  });

  it('does not hand back the wallet key itself', async () => {
    // The whole point of a KDF here: an Atomic key leaking must not compromise
    // the NextGraph wallet it came from.
    expect(await deriveAgentSeed(bytes, 'wallet-1')).not.toEqual(bytes);
  });

  it('produces an Atomic-shaped private key: 32 bytes, url-safe base64', async () => {
    const key = await deriveAtomicPrivateKey(wallet({ master_key: material }));

    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).not.toContain('=');
    // 32 bytes → 43 unpadded base64 characters.
    expect(key).toHaveLength(43);
  });

  it('matches the encoding Atomic uses for keys', () => {
    // `browser/lib/src/base64.ts`: base64, then +/ → -_, then padding stripped.
    expect(encodeB64Url(Uint8Array.from([251, 255, 190]))).toBe('-_--');
    expect(encodeB64Url(Uint8Array.from([1]))).toBe('AQ');
  });
});
