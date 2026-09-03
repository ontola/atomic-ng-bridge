import { describe, expect, it } from 'vitest';
import {
  ATOMIC_IS_A,
  AtomicDatatype,
  VOLATILE_PROPERTIES,
  isVolatileProperty,
  bridge,
  rdf,
  resourceToTriples,
  triplesToPropVals,
  xsd,
  type DatatypeResolver,
} from '../src/index.js';

const S = 'did:ad:resource:task-1';
const P = (name: string) => `https://atomicdata.dev/properties/${name}`;

/** A resolver built from a plain map, standing in for loaded Property resources. */
const resolver = (map: Record<string, string>): DatatypeResolver => property =>
  map[property];

/**
 * Round trip: Atomic -> triples -> Atomic. The declared datatypes are known on
 * both legs, which is the normal case once the Property resources are mirrored.
 */
function roundTrip(
  propVals: Record<string, unknown>,
  datatypes: Record<string, string>,
) {
  const datatypeOf = resolver(datatypes);
  const { triples, warnings } = resourceToTriples(S, propVals, { datatypeOf });
  const back = triplesToPropVals(triples, { datatypeOf });

  return { triples, warnings, propVals: back.propVals };
}

describe('datatype round trips', () => {
  it('keeps strings, slugs and markdown distinct via the declared datatype', () => {
    const props = {
      [P('name')]: 'Buy milk',
      [P('shortname')]: 'buy-milk',
      [P('description')]: '# Heading\n\nBody',
    };
    const datatypes = {
      [P('name')]: AtomicDatatype.STRING,
      [P('shortname')]: AtomicDatatype.SLUG,
      [P('description')]: AtomicDatatype.MARKDOWN,
    };

    const { propVals, triples } = roundTrip(props, datatypes);

    expect(propVals).toEqual(props);
    // All three land on plain literals; the datatype distinction lives in the
    // Property resource, which is mirrored alongside.
    expect(triples.every(t => t.object.termType === 'literal')).toBe(true);
  });

  it('round trips numbers, booleans and dates', () => {
    const props = {
      [P('count')]: 42,
      [P('ratio')]: 0.5,
      [P('done')]: false,
      [P('due')]: '2026-08-28',
    };
    const datatypes = {
      [P('count')]: AtomicDatatype.INTEGER,
      [P('ratio')]: AtomicDatatype.FLOAT,
      [P('done')]: AtomicDatatype.BOOLEAN,
      [P('due')]: AtomicDatatype.DATE,
    };

    const { propVals, triples } = roundTrip(props, datatypes);

    expect(propVals).toEqual(props);
    expect(triples.find(t => t.predicate === P('count'))?.object).toMatchObject({
      datatype: xsd.integer,
      value: '42',
    });
  });

  it('round trips a timestamp losslessly, including milliseconds', () => {
    const ms = 1_756_400_123_456;
    const datatypes = { [P('createdAt')]: AtomicDatatype.TIMESTAMP };

    const { propVals, triples } = roundTrip({ [P('createdAt')]: ms }, datatypes);

    expect(propVals[P('createdAt')]).toBe(ms);
    expect(triples[0]!.object).toMatchObject({
      datatype: xsd.dateTime,
      value: '2025-08-28T16:55:23.456Z',
    });
  });

  it('maps atomicURL to an IRI and uri to a literal', () => {
    const props = {
      [P('parent')]: 'did:ad:resource:drive-1',
      [P('homepage')]: 'https://example.com/page',
    };
    const datatypes = {
      [P('parent')]: AtomicDatatype.ATOMIC_URL,
      [P('homepage')]: AtomicDatatype.URI,
    };

    const { propVals, triples } = roundTrip(props, datatypes);

    expect(propVals).toEqual(props);
    expect(triples.find(t => t.predicate === P('parent'))?.object.termType).toBe(
      'iri',
    );
    expect(
      triples.find(t => t.predicate === P('homepage'))?.object,
    ).toMatchObject({ termType: 'literal', datatype: xsd.anyURI });
  });

  it('round trips localized text as language-tagged literals', () => {
    const value = { en: 'Hello', nl: 'Hallo' };
    const datatypes = { [P('greeting')]: AtomicDatatype.LOCALIZEDTEXT };

    const { propVals, triples } = roundTrip({ [P('greeting')]: value }, datatypes);

    expect(propVals[P('greeting')]).toEqual(value);
    expect(triples.map(t => (t.object as { language?: string }).language).sort()).toEqual([
      'en',
      'nl',
    ]);
  });

  it('round trips json', () => {
    const value = { nested: { list: [1, 2, 3] }, flag: true };
    const datatypes = { [P('config')]: AtomicDatatype.JSON };

    const { propVals, triples } = roundTrip({ [P('config')]: value }, datatypes);

    expect(propVals[P('config')]).toEqual(value);
    expect(triples[0]!.object).toMatchObject({ datatype: rdf.JSON });
  });

  it('round trips a loro document as opaque base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 42]);
    const datatypes = { [P('body')]: AtomicDatatype.LORODOC };

    const { propVals, triples } = roundTrip({ [P('body')]: bytes }, datatypes);

    expect(propVals[P('body')]).toEqual(bytes);
    expect(triples[0]!.object).toMatchObject({ datatype: bridge.loroDoc });
  });
});

describe('resourceArray ordering', () => {
  const datatypes = { [P('subResources')]: AtomicDatatype.RESOURCEARRAY };
  const members = ['did:ad:resource:c', 'did:ad:resource:a', 'did:ad:resource:b'];

  it('emits real member triples plus one bookkeeping triple', () => {
    const { triples } = resourceToTriples(
      S,
      { [P('subResources')]: members },
      { datatypeOf: resolver(datatypes) },
    );

    const memberTriples = triples.filter(t => t.predicate === P('subResources'));
    const orderTriples = triples.filter(t => t.predicate === bridge.arrayOrder);

    expect(memberTriples).toHaveLength(3);
    expect(memberTriples.every(t => t.object.termType === 'iri')).toBe(true);
    expect(orderTriples).toHaveLength(1);
  });

  it('restores the exact order, which plain triples cannot express', () => {
    const { propVals } = roundTrip({ [P('subResources')]: members }, datatypes);

    expect(propVals[P('subResources')]).toEqual(members);
  });

  it('appends members a NextGraph-side writer added, deterministically', () => {
    const { triples } = resourceToTriples(
      S,
      { [P('subResources')]: members },
      { datatypeOf: resolver(datatypes) },
    );

    // A native NextGraph consumer adds a member without knowing about the
    // bookkeeping triple. It must not be dropped, and its position must be
    // stable across reads.
    triples.push({
      subject: S,
      predicate: P('subResources'),
      object: { termType: 'iri', value: 'did:ad:resource:zz-new' },
    });

    const { propVals } = triplesToPropVals(triples, {
      datatypeOf: resolver(datatypes),
    });

    expect(propVals[P('subResources')]).toEqual([...members, 'did:ad:resource:zz-new']);
  });

  it('falls back to a sorted order when the bookkeeping triple is missing', () => {
    const { triples } = resourceToTriples(
      S,
      { [P('subResources')]: members },
      { datatypeOf: resolver(datatypes) },
    );

    const withoutOrder = triples.filter(t => t.predicate !== bridge.arrayOrder);
    const { propVals } = triplesToPropVals(withoutOrder, {
      datatypeOf: resolver(datatypes),
    });

    expect(propVals[P('subResources')]).toEqual([...members].sort());
  });
});

describe('isA and rdf:type', () => {
  const classes = ['https://atomicdata.dev/classes/Task'];
  const datatypes = { [ATOMIC_IS_A]: AtomicDatatype.RESOURCEARRAY };

  it('emits rdf:type alongside isA so native queries work', () => {
    const { triples } = resourceToTriples(
      S,
      { [ATOMIC_IS_A]: classes },
      { datatypeOf: resolver(datatypes) },
    );

    expect(triples.filter(t => t.predicate === rdf.type)).toHaveLength(1);
    expect(triples.filter(t => t.predicate === ATOMIC_IS_A)).toHaveLength(1);
  });

  it('ignores rdf:type on the way back, so it never becomes a property', () => {
    const { propVals } = roundTrip({ [ATOMIC_IS_A]: classes }, datatypes);

    expect(propVals).toEqual({ [ATOMIC_IS_A]: classes });
    expect(propVals[rdf.type]).toBeUndefined();
  });
});

describe('what the mapping cannot do faithfully, reported rather than swallowed', () => {
  it('warns when a nested resource is inlined under atomicURL', () => {
    const { warnings, propVals } = roundTrip(
      { [P('parent')]: { name: 'inline' } },
      { [P('parent')]: AtomicDatatype.ATOMIC_URL },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('lossy-nested-resource');
    // Lossy for native consumers, exact for us.
    expect(propVals[P('parent')]).toEqual({ name: 'inline' });
  });

  it('warns when an array holds nested resources, and still round trips', () => {
    const value = [{ name: 'a' }, { name: 'b' }];
    const { warnings, propVals } = roundTrip(
      { [P('subResources')]: value },
      { [P('subResources')]: AtomicDatatype.RESOURCEARRAY },
    );

    expect(warnings[0]!.kind).toBe('lossy-nested-resource');
    expect(propVals[P('subResources')]).toEqual(value);
  });

  it('warns on an unknown datatype instead of dropping the value', () => {
    const { warnings, propVals } = roundTrip(
      { [P('mystery')]: 'value' },
      { [P('mystery')]: 'https://example.com/datatypes/unknown' },
    );

    expect(warnings[0]!.kind).toBe('unknown-datatype');
    expect(propVals[P('mystery')]).toBe('value');
  });

  it('skips undefined values rather than emitting empty literals', () => {
    const { triples } = resourceToTriples(S, {
      [P('name')]: undefined,
      [P('other')]: null,
    });

    expect(triples).toHaveLength(0);
  });
});

describe('without a datatype resolver', () => {
  it('infers from the value, which is enough for everything but string subtypes', () => {
    const { triples } = resourceToTriples(S, {
      [P('count')]: 7,
      [P('done')]: true,
      [P('members')]: ['did:ad:a', 'did:ad:b'],
    });

    const { propVals } = triplesToPropVals(triples);

    expect(propVals[P('count')]).toBe(7);
    expect(propVals[P('done')]).toBe(true);
    expect(propVals[P('members')]).toEqual(['did:ad:a', 'did:ad:b']);
  });
});

describe('input shapes', () => {
  it('accepts a Map, which is what getPropVals returns in some versions', () => {
    const map = new Map<string, unknown>([[P('name'), 'From a map']]);
    const { triples } = resourceToTriples(S, map);

    expect(triples).toEqual([
      {
        subject: S,
        predicate: P('name'),
        object: { termType: 'literal', value: 'From a map', datatype: undefined, language: undefined },
      },
    ]);
  });
});

describe('properties the mirror must never carry', () => {
  /**
   * Regression guard for a live incident: with `lastCommit`
   * mirrored, pull applied a change, the local save minted a new `lastCommit`,
   * push wrote it to NextGraph, the document subscription fired, pull applied
   * it again — forever. It wedged the browser tab. The content-hash cursor
   * cannot stop this, because the content genuinely differs each round.
   */
  it('treats lastCommit as volatile', () => {
    expect(isVolatileProperty('https://atomicdata.dev/properties/lastCommit')).toBe(
      true,
    );
    expect(VOLATILE_PROPERTIES).toContain(
      'https://atomicdata.dev/properties/lastCommit',
    );
  });

  it('does not treat ordinary properties as volatile', () => {
    expect(isVolatileProperty(P('name'))).toBe(false);
    expect(isVolatileProperty(ATOMIC_IS_A)).toBe(false);
  });
});
