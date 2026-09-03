/**
 * Unlocking the wallet with a passkey, so nothing has to be typed or stored.
 *
 * The problem this solves: a wallet needs a password, and the honest options
 * were "ask the user for one every reload" or "keep it in localStorage", which
 * is a secret sitting in plain sight. Neither is what "one secret, smooth UX"
 * should mean.
 *
 * WebAuthn's PRF extension gives a third option. A passkey can produce a
 * stable 32-byte secret for a given salt, but only after the user authenticates
 * — Touch ID, Windows Hello, a security key. We use that secret to wrap the
 * wallet password: the password is random, never shown, never typed, and stored
 * only in encrypted form. Unlocking is a fingerprint.
 *
 * ## Wrapping rather than deriving
 *
 * The password could have been the PRF output directly, which stores nothing at
 * all. Wrapping is better for two reasons that matter later: a second device
 * can be added by wrapping the same password under a second passkey, and the
 * password can be exported deliberately if a user ever needs to open their
 * wallet somewhere without their authenticator. Deriving would make the
 * authenticator the single point of failure for the data.
 *
 * ## What this does not do
 *
 * Passkeys are per-device (unless the platform syncs them). Losing every
 * authenticator with no export means losing the wrapped password, and with it a
 * wallet this code generated. For a user's *own* wallet the recovery story is
 * NextGraph's, not ours, and that is the configuration a real deployment should
 * use.
 */

const PRF_SALT_LABEL = 'atomic-ng-bridge/wallet-password/v1';
const RP_NAME = 'Atomic ⇄ NextGraph bridge';

export type PasskeyRecord = {
  /** Credential id, base64url. */
  credentialId: string;
  /** PRF salt, base64url. Fixed per record, so the same secret comes back. */
  salt: string;
  /** AES-GCM iv, base64url. */
  iv: string;
  /** The wallet password, encrypted. base64url. */
  wrapped: string;
  createdAt: number;
};

export class PasskeyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyUnsupportedError';
  }
}

const encoder = new TextEncoder();

export const toB64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const fromB64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));

  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

/** Whether this browser has a platform authenticator at all. */
export async function passkeysAvailable(): Promise<boolean> {
  if (
    typeof PublicKeyCredential === 'undefined' ||
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ===
      undefined
  ) {
    return false;
  }

  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

type PrfExtensionResults = {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

/**
 * Creates a passkey for this origin and reports whether it can do PRF.
 *
 * PRF support cannot be feature-detected before creation: the credential has to
 * exist before the browser will say whether the authenticator supports it. So
 * this creates, checks, and tells the caller — which is why the caller must be
 * prepared to fall back rather than assume.
 */
export async function createPasskey(label: string): Promise<{
  credentialId: string;
  prfSupported: boolean;
}> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: RP_NAME },
      user: { id: userId, name: label, displayName: label },
      // ES256 then RS256: the two every authenticator implements.
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      timeout: 60_000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (credential === null) {
    throw new PasskeyUnsupportedError('No credential was created.');
  }

  const results =
    credential.getClientExtensionResults() as PrfExtensionResults;

  return {
    credentialId: toB64Url(new Uint8Array(credential.rawId)),
    prfSupported: results.prf?.enabled === true,
  };
}

/** Asks the authenticator for this record's secret. Requires user verification. */
async function prfSecret(
  credentialId: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [
        { type: 'public-key', id: fromB64Url(credentialId) as BufferSource },
      ],
      userVerification: 'required',
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (assertion === null) {
    throw new PasskeyUnsupportedError('The passkey did not respond.');
  }

  const first = (assertion.getClientExtensionResults() as PrfExtensionResults)
    .prf?.results?.first;

  if (first === undefined) {
    throw new PasskeyUnsupportedError(
      'This authenticator did not return a PRF secret.',
    );
  }

  return new Uint8Array(first);
}

/** AES-GCM key from the PRF secret, domain-separated from any other use. */
async function wrappingKey(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    secret as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(PRF_SALT_LABEL),
      info: encoder.encode('aes-gcm'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts a wallet password under a freshly created passkey. */
export async function wrapPassword(
  credentialId: string,
  password: string,
): Promise<PasskeyRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(await prfSecret(credentialId, salt));

  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      encoder.encode(password) as unknown as BufferSource,
    ),
  );

  return {
    credentialId,
    salt: toB64Url(salt),
    iv: toB64Url(iv),
    wrapped: toB64Url(wrapped),
    createdAt: Date.now(),
  };
}

/** Decrypts the wallet password. Prompts the authenticator. */
export async function unwrapPassword(
  record: PasskeyRecord,
): Promise<string> {
  const key = await wrappingKey(
    await prfSecret(record.credentialId, fromB64Url(record.salt)),
  );

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64Url(record.iv) as unknown as BufferSource },
    key,
    fromB64Url(record.wrapped) as unknown as BufferSource,
  );

  return new TextDecoder().decode(plain);
}
