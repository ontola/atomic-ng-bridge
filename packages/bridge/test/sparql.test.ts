import { describe, expect, it } from 'vitest';
import {
  deleteSubjectUpdate,
  escapeLiteral,
  insertTriplesUpdate,
  replaceSubjectSteps,
  replaceSubjectUpdate,
  selectSubjectQuery,
  serializeTerm,
  serializeIri,
  xsd,
} from '../src/index.js';

const GRAPH = 'did:ng:o:abcdef';
const S = 'did:ad:resource:task-1';
const P = 'https://atomicdata.dev/properties/name';

describe('serialization', () => {
  it('escapes quotes, backslashes and newlines in literals', () => {
    expect(escapeLiteral('say "hi"\\ok\nnext')).toBe(
      'say \\"hi\\"\\\\ok\\nnext',
    );
  });

  it('refuses an IRI that could break out of the angle brackets', () => {
    expect(() => serializeIri('did:ad:x> . <did:ad:y')).toThrow(/illegal/);
    expect(() => serializeIri('did:ad:with space')).toThrow(/illegal/);
  });

  it('accepts ordinary http and did IRIs', () => {
    expect(serializeIri('https://example.com/a#b?c=1')).toBe(
      '<https://example.com/a#b?c=1>',
    );
    expect(serializeIri(S)).toBe(`<${S}>`);
  });

  it('writes plain literals without a datatype, typed ones with', () => {
    expect(serializeTerm({ termType: 'literal', value: 'plain' })).toBe(
      '"plain"',
    );
    expect(
      serializeTerm({ termType: 'literal', value: '42', datatype: xsd.integer }),
    ).toBe(`"42"^^<${xsd.integer}>`);
  });

  it('writes a language tag instead of a datatype', () => {
    expect(
      serializeTerm({ termType: 'literal', value: 'Hallo', language: 'nl' }),
    ).toBe('"Hallo"@nl');
  });
});

describe('updates', () => {
  const triples = [
    {
      subject: S,
      predicate: P,
      object: { termType: 'literal' as const, value: 'Buy milk' },
    },
  ];

  it('scopes the delete to one subject in one graph', () => {
    const update = deleteSubjectUpdate(GRAPH, S);

    expect(update).toContain(`GRAPH <${GRAPH}>`);
    expect(update).toContain(`<${S}> ?p ?o`);
    // A delete that is not subject-scoped would take the whole graph with it.
    expect(update).not.toMatch(/\?s\s+\?p\s+\?o/);
  });

  it('produces a two-step replace, usable when ;-separation is unsupported', () => {
    const steps = replaceSubjectSteps(GRAPH, S, triples);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('DELETE');
    expect(steps[1]).toContain('INSERT DATA');
  });

  it('joins the same steps into one update when the engine accepts it', () => {
    expect(replaceSubjectUpdate(GRAPH, S, triples)).toBe(
      replaceSubjectSteps(GRAPH, S, triples).join(';\n'),
    );
  });

  it('emits only the delete when the resource has no triples left', () => {
    expect(replaceSubjectSteps(GRAPH, S, [])).toHaveLength(1);
  });

  it('puts every insert inside the named graph', () => {
    expect(insertTriplesUpdate(GRAPH, triples)).toContain(`GRAPH <${GRAPH}>`);
  });
});

describe('queries', () => {
  it('reads one subject back, scoped to the graph', () => {
    const query = selectSubjectQuery(GRAPH, S);

    expect(query).toContain(`GRAPH <${GRAPH}>`);
    expect(query).toContain(`<${S}> ?p ?o`);
  });
});
