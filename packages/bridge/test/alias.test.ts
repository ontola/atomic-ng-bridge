import { describe, expect, it } from 'vitest';
import {
  ATOMIC_IS_A,
  AtomicDatatype,
  aliasResourceTriples,
  atomicSubjectOf,
  bridge,
  documentPrefix,
  isDriveResource,
  iri,
  ngSubjectFor,
  rdf,
  resourceToTriples,
  triplesToPropVals,
  unaliasResourceTriples,
} from '../src/index.js';
import { sha256 } from '../src/sha256.js';

const DOC = 'did:ng:o:Dn0QpE9_4jhta1mUWRl_LZh1SbXUkXfOB5eu38PNIk4A';
const GRAPH = `${DOC}:v:Z4ihjV3KMVIqBxzjP6hogVLyjkZunLsb7MMsCR0kizQA`;
const ROW = 'did:ad:LQ3OzC0m9m3mZ4Hn7rY2jvbVQ5Wf8k1PpX9dY6c2Q0s';
const TABLE = 'did:ad:ao_Xq1vYb0f9zKQmN3tL8sR7uW2cE5hJ4gD6iF0kA1o';
const P = (name: string) => `https://atomicdata.dev/properties/${name}`;
const datatypes: Record<string, string> = {
  [P('name')]: AtomicDatatype.STRING,
  [P('parent')]: AtomicDatatype.ATOMIC_URL,
  [ATOMIC_IS_A]: AtomicDatatype.RESOURCEARRAY,
};
const datatypeOf = (property: string) => datatypes[property];

const toHex = (bytes: Uint8Array) =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

describe('sha256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(toHex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(toHex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // Crosses one block boundary: 56 bytes of message plus padding needs a
    // second block.
    expect(
      toHex(
        sha256(
          new TextEncoder().encode(
            'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
          ),
        ),
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
});

describe('the NextGraph subject for an Atomic resource', () => {
  it('is the document nuri plus an opaque 44-character suffix, like the ORM mints', () => {
    const subject = ngSubjectFor(ROW, GRAPH);

    expect(subject.startsWith(`${DOC}:q:`)).toBe(true);
    expect(subject.slice(`${DOC}:q:`.length)).toMatch(/^[A-Za-z0-9_-]{44}$/);
  });

  it('drops the overlay from the graph nuri, so the prefix is the document', () => {
    expect(documentPrefix(GRAPH)).toBe(DOC);
    expect(documentPrefix(DOC)).toBe(DOC);
  });

  it('is deterministic, so the push side needs no lookup table', () => {
    expect(ngSubjectFor(ROW, GRAPH)).toBe(ngSubjectFor(ROW, GRAPH));
    expect(ngSubjectFor(ROW, GRAPH)).not.toBe(ngSubjectFor(TABLE, GRAPH));
  });

  it('leaves identities and history alone: agents, devices, commits', () => {
    for (const subject of [
      'did:ad:agent:abc',
      'did:ad:node:abc',
      'did:ad:commit:abc',
      'https://atomicdata.dev/classes/Table',
      'did:ng:o:someone-elses:q:x',
    ]) {
      expect(isDriveResource(subject)).toBe(false);
      expect(ngSubjectFor(subject, GRAPH)).toBe(subject);
    }
  });
});

describe('aliasing a resource for the document', () => {
  const propVals = {
    [P('name')]: 'Dune',
    [P('parent')]: TABLE,
    [ATOMIC_IS_A]: [TABLE],
  };
  const mapped = resourceToTriples(ROW, propVals, { datatypeOf }).triples;
  const stored = aliasResourceTriples(ROW, mapped, GRAPH);

  it('writes no did:ad in any subject, link or class', () => {
    expect(stored.subject).toBe(ngSubjectFor(ROW, GRAPH));

    const data = stored.triples.filter(t => t.predicate !== bridge.atomicSubject);

    expect(JSON.stringify(data)).not.toContain('did:ad:');
    // The origin record is the one place the Atomic subject appears.
    expect(
      stored.triples.filter(t => t.predicate === bridge.atomicSubject),
    ).toEqual([
      { subject: stored.subject, predicate: bridge.atomicSubject, object: iri(ROW) },
    ]);
  });

  it('keeps rdf:type usable by a native query, pointing at the aliased class', () => {
    const type = stored.triples.find(t => t.predicate === rdf.type);

    expect(type?.object).toEqual(iri(ngSubjectFor(TABLE, GRAPH)));
  });

  it('records the origin exactly once, and not for a native subject', () => {
    expect(atomicSubjectOf(stored.triples)).toBe(ROW);

    const native = aliasResourceTriples(
      'did:ng:o:doc:q:native',
      resourceToTriples('did:ng:o:doc:q:native', { [P('name')]: 'x' }, { datatypeOf }).triples,
      GRAPH,
    );

    expect(native.subject).toBe('did:ng:o:doc:q:native');
    expect(atomicSubjectOf(native.triples)).toBeUndefined();
  });

  it('round trips through the alias map, links included', () => {
    const aliases = new Map([
      [ngSubjectFor(ROW, GRAPH), ROW],
      [ngSubjectFor(TABLE, GRAPH), TABLE],
    ]);
    const back = unaliasResourceTriples(stored.subject, stored.triples, aliases);
    const { propVals: restored } = triplesToPropVals(back.triples, { datatypeOf });

    expect(back.subject).toBe(ROW);
    expect(restored).toEqual(propVals);
  });

  it('resolves its own subject from the origin record even with an empty map', () => {
    const back = unaliasResourceTriples(stored.subject, stored.triples, new Map());

    expect(back.subject).toBe(ROW);
  });

  it('keeps a link to a native resource as it is: that IRI is its identity on both sides', () => {
    const native = 'did:ng:o:doc:q:made-by-a-native-app';
    const back = unaliasResourceTriples(
      stored.subject,
      [{ subject: stored.subject, predicate: P('parent'), object: iri(native) }],
      new Map(),
    );

    expect(back.triples[0]!.object).toEqual(iri(native));
    expect(back.subject).toBe(stored.subject);
  });
});
