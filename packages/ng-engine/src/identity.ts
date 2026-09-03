/**
 * One secret: the NextGraph wallet.
 *
 * The Atomic side needs a signing key of its own. Asking a user to manage a
 * second secret alongside their wallet is the thing we are trying to avoid, so
 * we derive that key from the wallet instead: same wallet, same Atomic identity,
 * on every device, with nothing extra to back up, write down, or lose.
 *
 * ## Why derivation rather than storage
 *
 * NextGraph's wallet has a purpose-built slot for exactly this — `third_parties`
 * in `SensitiveWalletV0`, *"third parties data saved in the wallet… the format
 * of the byte array is up to the vendor"* — with `AddThirdPartyDataV0` and
 * `RemoveThirdPartyDataV0` as first-class wallet operations that the engine
 * applies (`engine/wallet/src/types.rs:811`). That would have been the better
 * design: an explicit slot, no cryptographic re-use, and it travels with the
 * wallet through export, QR pairing and the recovery kit.
 *
 * It is not reachable from JavaScript. `wallet_update`, the only entry point,
 * deserializes its arguments and then calls `unimplemented!()`
 * (`sdk/js/lib-wasm/src/lib.rs:272`), so calling it aborts the wasm. See
 * `NEXTGRAPH-ISSUES.md` A11. If that is ever implemented, storing the secret
 * should replace this file, and `deriveAgentSeed` becomes the migration path
 * for wallets created before the change.
 *
 * ## What this does instead
 *
 * HKDF-SHA256 over key material already inside the opened wallet, domain
 * separated so the output is useless for anything but this. An Atomic private
 * key is 32 raw bytes (`browser/lib/src/CryptoProvider.ts`), so the derived
 * bytes are directly usable, with no format conversion to get wrong.
 */

/** The shape the wasm hands back from `wallet_open_with_*`. */
export type OpenedWalletV0 = {
  V0: {
    wallet_id: string;
    personal_site: string;
    /** 32 bytes, when the wallet carries one. */
    master_key?: number[] | Uint8Array;
    /** Serialized `PrivKey`, e.g. `{ Ed25519PrivKey: [ … ] }`. */
    wallet_privkey?: Record<string, number[]> | number[];
  };
};

export class NoWalletKeyMaterialError extends Error {
  constructor() {
    super(
      'The opened wallet exposes neither master_key nor wallet_privkey, so an ' +
        'Atomic identity cannot be derived from it. See NEXTGRAPH-ISSUES.md A11.',
    );
    this.name = 'NoWalletKeyMaterialError';
  }
}

const toBytes = (value: number[] | Uint8Array): Uint8Array =>
  value instanceof Uint8Array ? value : Uint8Array.from(value);

/**
 * Digs the wallet's own key bytes out of the opened wallet.
 *
 * Prefers `master_key`, which is the wallet's root secret and stable for the
 * life of the wallet. Falls back to `wallet_privkey`, which is serialized as a
 * tagged enum (`{Ed25519PrivKey: […]}`) rather than a bare array.
 */
export function walletKeyMaterial(opened: OpenedWalletV0): Uint8Array {
  const master = opened.V0.master_key;

  if (master !== undefined && toBytes(master).length > 0) {
    return toBytes(master);
  }

  const priv = opened.V0.wallet_privkey;

  if (priv === undefined) {
    throw new NoWalletKeyMaterialError();
  }

  if (Array.isArray(priv)) {
    return toBytes(priv);
  }

  const inner = Object.values(priv)[0];

  if (inner === undefined) {
    throw new NoWalletKeyMaterialError();
  }

  return toBytes(inner);
}

/**
 * Domain separation. Changing this string changes every derived identity, so it
 * is versioned: a future scheme gets `…/v2` and a migration, never a silent
 * reinterpretation of the same wallet.
 */
const INFO = 'atomic-ng-bridge/atomic-agent/v1';

/**
 * 32 bytes for an Atomic private key, derived from the wallet.
 *
 * The wallet id is the salt, so two wallets never collide even if some future
 * NextGraph version reuses key material.
 */
export async function deriveAgentSeed(
  material: Uint8Array,
  walletId: string,
  crypto: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    material as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(walletId),
      info: new TextEncoder().encode(INFO),
    },
    key,
    256,
  );

  return new Uint8Array(bits);
}

/**
 * URL-safe, unpadded base64 — the encoding Atomic uses for keys and subjects
 * (`browser/lib/src/base64.ts`). Reimplemented rather than imported so this
 * package stays free of `@tomic/lib`.
 */
export function encodeB64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The wallet-derived Atomic private key, ready for `@tomic/lib`. */
export async function deriveAtomicPrivateKey(
  opened: OpenedWalletV0,
): Promise<string> {
  const seed = await deriveAgentSeed(
    walletKeyMaterial(opened),
    opened.V0.wallet_id,
  );

  return encodeB64Url(seed);
}
