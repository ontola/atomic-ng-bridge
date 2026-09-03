import { describe, expect, it, vi } from 'vitest';
import { bindingsToTriples, bindingsToValues } from '../src/index.js';

const S = 'did:ad:resource:1';
const results = (bindings: unknown[]) => ({ results: { bindings } });

describe('reading SELECT ?p ?o results back into triples', () => {
  it('maps IRI and literal objects', () => {
    const triples = bindingsToTriples(
      S,
      results([
        {
          p: { type: 'uri', value: 'https://atomicdata.dev/properties/parent' },
          o: { type: 'uri', value: 'did:ad:resource:drive' },
        },
        {
          p: { type: 'uri', value: 'https://atomicdata.dev/properties/name' },
          o: { type: 'literal', value: 'Buy milk' },
        },
      ]),
    );

    expect(triples).toEqual([
      {
        subject: S,
        predicate: 'https://atomicdata.dev/properties/parent',
        object: { termType: 'iri', value: 'did:ad:resource:drive' },
      },
      {
        subject: S,
        predicate: 'https://atomicdata.dev/properties/name',
        object: {
          termType: 'literal',
          value: 'Buy milk',
          datatype: undefined,
          language: undefined,
        },
      },
    ]);
  });

  it('keeps datatypes and language tags', () => {
    const triples = bindingsToTriples(
      S,
      results([
        {
          p: { type: 'uri', value: 'p:count' },
          o: {
            type: 'literal',
            value: '42',
            datatype: 'http://www.w3.org/2001/XMLSchema#integer',
          },
        },
        {
          p: { type: 'uri', value: 'p:greeting' },
          o: { type: 'literal', value: 'Hallo', 'xml:lang': 'nl' },
        },
      ]),
    );

    expect(triples[0]!.object).toMatchObject({
      datatype: 'http://www.w3.org/2001/XMLSchema#integer',
    });
    expect(triples[1]!.object).toMatchObject({ language: 'nl' });
  });

  it('skips a blank node and reports it, rather than losing the resource', () => {
    const onSkipped = vi.fn();
    const triples = bindingsToTriples(
      S,
      results([
        { p: { type: 'uri', value: 'p:a' }, o: { type: 'bnode', value: 'b0' } },
        { p: { type: 'uri', value: 'p:b' }, o: { type: 'literal', value: 'ok' } },
      ]),
      onSkipped,
    );

    expect(triples).toHaveLength(1);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped.mock.calls[0]![0].message).toContain('blank node');
  });

  it('tolerates an empty or unexpected response instead of throwing', () => {
    expect(bindingsToTriples(S, undefined)).toEqual([]);
    expect(bindingsToTriples(S, true)).toEqual([]);
    expect(bindingsToTriples(S, { results: {} })).toEqual([]);
  });
});

describe('reading a single variable', () => {
  it('collects the values of one column', () => {
    const values = bindingsToValues(
      results([
        { doc: { type: 'uri', value: 'did:ng:o:a' } },
        { doc: { type: 'uri', value: 'did:ng:o:b' } },
      ]),
      'doc',
    );

    expect(values).toEqual(['did:ng:o:a', 'did:ng:o:b']);
  });

  it('returns nothing when the variable is absent', () => {
    expect(bindingsToValues(results([{ other: { type: 'uri', value: 'x' } }]), 'doc')).toEqual([]);
  });
});
