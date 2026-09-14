/**
 * The Atomic identity, kept in the user's NextGraph private store.
 *
 * With the hosted wallet (`@ng-org/web`) the app never sees wallet material,
 * so `identity.ts`'s derivation has nothing to derive from. What it does have
 * is a session on the user's private store, which NextGraph encrypts with the
 * wallet and carries to every device the wallet is opened on. So the Atomic
 * signing key lives there: one small document, class
 * `AtomicNgBridgeIdentity`, holding the key as a literal. Same wallet, same
 * Atomic agent everywhere, and nothing for the user to manage.
 *
 * The key is generated once, on the first device, and read back after that.
 * It is a secret and it is written into a document only the wallet can open,
 * which is the same trust the wallet's own `third_parties` slot would give
 * if it were reachable from JavaScript (`NEXTGRAPH-ISSUES.md` A11).
 */

import { encodeB64Url } from './identity.js';
import { bindingsToValues } from './results.js';
import { findOrCreateDocument, type NgSession } from './session.js';
import type { NgWasm } from './wasm.js';

/** The class the identity document carries, so it can be found again. */
export const IDENTITY_CLASS = 'did:ng:z:AtomicNgBridgeIdentity';

/** The predicate holding the Atomic private key, URL-safe base64. */
export const PRIVATE_KEY_PREDICATE =
  'https://atomicdata.dev/ng-bridge/atomicPrivateKey';

export type StoredIdentity = {
  /** The Atomic private key, ready for `@tomic/lib`. */
  privateKey: string;
  /** The document it lives in. */
  nuri: string;
  /** True when the key was generated now, false when read back. */
  created: boolean;
};

/**
 * Reads the wallet's Atomic key from its private store, generating and
 * storing one if this wallet has none yet.
 */
export async function ensureStoredIdentity(
  ng: NgWasm,
  session: NgSession,
  randomBytes: (length: number) => Uint8Array = length =>
    crypto.getRandomValues(new Uint8Array(length)),
): Promise<StoredIdentity> {
  const { nuri } = await findOrCreateDocument(ng, session, IDENTITY_CLASS);

  const existing = bindingsToValues(
    await ng.sparql_query(
      session.sessionId,
      `SELECT ?key WHERE { GRAPH <${nuri}> { <${nuri}> <${PRIVATE_KEY_PREDICATE}> ?key } }`,
      undefined,
      nuri,
    ),
    'key',
  );

  if (existing[0] !== undefined && existing[0] !== '') {
    return { privateKey: existing[0], nuri, created: false };
  }

  const privateKey = encodeB64Url(randomBytes(32));

  await ng.sparql_update(
    session.sessionId,
    `INSERT DATA { GRAPH <${nuri}> { <${nuri}> <${PRIVATE_KEY_PREDICATE}> "${privateKey}" } }`,
    nuri,
  );

  return { privateKey, nuri, created: true };
}
