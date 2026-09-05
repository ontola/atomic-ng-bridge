/**
 * NextGraph-native subjects for Atomic resources.
 *
 * An Atomic resource in a local drive is `did:ad:<signature>`: its subject is
 * the signature of the commit that created it, so it is not known until that
 * commit is signed. A NextGraph subject is `did:ng:o:<docId>:q:<random>`, the
 * document's nuri plus an opaque suffix, which is what the NG ORM mints for
 * `"@id": ""`. Neither can be made equal to the other, so the bridge keeps the
 * Atomic subject locally and writes the document under a NextGraph one:
 *
 *   did:ad:X  ->  did:ng:o:<docId>:q:<base64url(sha256(X) ++ 1 byte)>
 *
 * Derived, not stored, so the push side needs no lookup, and 44 characters
 * long, which is the shape the ORM's own subjects have. One extra triple per
 * subject, `<ng> bridge:atomicSubject <did:ad:X>`, records the origin so the
 * pull side can map back; that triple is the only state involved. Every IRI
 * that points at another Atomic resource (relations, array members, classes
 * under `isA` and `rdf:type`) is rewritten the same way, so links between rows
 * are NextGraph subjects too and a native app never sees `did:ad:`.
 *
 * A subject that is already `did:ng:` (a resource a NextGraph-native app
 * created, pulled in by us) is left alone in both directions: its NextGraph
 * subject is its Atomic subject.
 */

import { bytesToBase64 } from './base64.js';
import { sha256 } from './sha256.js';
import { iri, type Term, type Triple } from './types.js';
import { bridge } from './vocab.js';

const NG_DOC_PREFIX = 'did:ng:o:';

/** `did:ng:o:<docId>`, with any `:v:<overlay>` suffix of the graph nuri dropped. */
export function documentPrefix(graph: string): string {
  const overlay = graph.indexOf(':v:');

  return overlay === -1 ? graph : graph.slice(0, overlay);
}

/**
 * Whether this Atomic IRI names a resource that lives in the mirrored drive.
 *
 * Agents, devices and commits are `did:ad:` too, but they are identities and
 * history, not resources in the document, so a link to one stays as it is.
 */
export function isDriveResource(subject: string): boolean {
  return (
    subject.startsWith('did:ad:') &&
    !subject.startsWith('did:ad:agent:') &&
    !subject.startsWith('did:ad:node:') &&
    !subject.startsWith('did:ad:commit:')
  );
}

const base64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The NextGraph subject for an Atomic one. Deterministic: the same Atomic
 * subject in the same document always aliases to the same IRI.
 */
export function ngSubjectFor(subject: string, graph: string): string {
  if (!isDriveResource(subject)) {
    return subject;
  }

  const digest = sha256(new TextEncoder().encode(subject));
  // 33 bytes, so the suffix is 44 characters like the ORM's random ones.
  const bytes = new Uint8Array(33);
  bytes.set(digest);
  bytes[32] = sha256(digest)[0]!;

  return `${documentPrefix(graph)}:q:${base64url(bytes)}`;
}

const aliasTerm = (term: Term, graph: string): Term =>
  term.termType === 'iri' && isDriveResource(term.value)
    ? iri(ngSubjectFor(term.value, graph))
    : term;

export type AliasedResource = {
  /** The subject the triples are written under in the document. */
  subject: string;
  triples: Triple[];
};

/**
 * Rewrites one resource's triples for the document: NextGraph subject,
 * NextGraph link targets, plus the origin triple when the subject was aliased.
 */
export function aliasResourceTriples(
  subject: string,
  triples: Triple[],
  graph: string,
): AliasedResource {
  const ngSubject = ngSubjectFor(subject, graph);
  const rewritten = triples.map(triple => ({
    subject: ngSubject,
    predicate: triple.predicate,
    object: aliasTerm(triple.object, graph),
  }));

  if (ngSubject !== subject) {
    rewritten.push({
      subject: ngSubject,
      predicate: bridge.atomicSubject,
      object: iri(subject),
    });
  }

  return { subject: ngSubject, triples: rewritten };
}

/** NextGraph subject -> Atomic subject, for everything the document records. */
export type AliasMap = ReadonlyMap<string, string>;

/** The Atomic subject a set of triples for one NextGraph subject declares, if any. */
export function atomicSubjectOf(triples: Triple[]): string | undefined {
  const origin = triples.find(
    triple =>
      triple.predicate === bridge.atomicSubject &&
      triple.object.termType === 'iri',
  );

  return origin?.object.value;
}

export type UnaliasedResource = {
  /** The Atomic subject: the recorded origin, the map's answer, or the NextGraph subject itself. */
  subject: string;
  /** The triples with link targets mapped back. The origin triple is kept; the mapping ignores it. */
  triples: Triple[];
};

/**
 * The reverse: triples read for one NextGraph subject, back to Atomic terms.
 * A link to a NextGraph subject the map does not know stays as it is: that is
 * a resource a native app created, and its NextGraph subject is its identity
 * on the Atomic side too.
 */
export function unaliasResourceTriples(
  ngSubject: string,
  triples: Triple[],
  aliases: AliasMap,
): UnaliasedResource {
  const subject =
    atomicSubjectOf(triples) ?? aliases.get(ngSubject) ?? ngSubject;

  return {
    subject,
    triples: triples.map(triple => ({
      subject,
      predicate: triple.predicate,
      object:
        triple.object.termType === 'iri'
          ? iri(aliases.get(triple.object.value) ?? triple.object.value)
          : triple.object,
    })),
  };
}
