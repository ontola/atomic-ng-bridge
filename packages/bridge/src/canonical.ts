/**
 * A stable fingerprint of what NextGraph holds for one subject.
 *
 * Used as the sync cursor. Two properties matter and both are load-bearing:
 * it must not depend on the order triples arrive in (RDF has none), and it must
 * be identical for the push and pull directions, so that a pulled write leaves
 * the push side with nothing to do. That is the whole echo-suppression story.
 */

import { serializeTerm, serializeIri } from './sparql.js';
import type { Triple } from './types.js';

/** One line per triple, sorted. Deterministic for any input order. */
export function canonicalizeTriples(triples: Triple[]): string {
  return triples
    .map(
      triple =>
        `${serializeIri(triple.predicate)} ${serializeTerm(triple.object)}`,
    )
    .sort()
    .join('\n');
}

/**
 * FNV-1a, twice, over the canonical form: 64 bits as hex.
 *
 * Not cryptographic, and it does not need to be. A collision would mean
 * skipping one push, so the bar is "vanishingly unlikely for resource-sized
 * payloads", not "adversary-resistant". If that ever stops being true, swap
 * this for SubtleCrypto and rebuild cursors.
 */
export function contentHash(triples: Triple[]): string {
  const input = canonicalizeTriples(triples);
  let a = 0x811c9dc5;
  let b = 0x01000193;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x85ebca6b);
  }

  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');

  return `${hex(a)}${hex(b)}`;
}
