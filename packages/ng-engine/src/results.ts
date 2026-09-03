/**
 * SPARQL JSON results -> the bridge's `Triple`s.
 *
 * `sparql_query` returns standard SPARQL 1.1 JSON (`results.bindings`), which
 * is what NextGraph's own examples read (`sdk/js/examples/expense-tracker-discrete`).
 */

import type { Term, Triple } from '@tomic/ng-bridge';
import type { SparqlBindingTerm, SparqlResults } from './wasm.js';

export class UnsupportedTermError extends Error {}

function toTerm(binding: SparqlBindingTerm): Term {
  if (binding.type === 'uri') {
    return { termType: 'iri', value: binding.value };
  }

  if (binding.type === 'bnode') {
    // Atomic has no blank nodes: every resource has a real subject. A blank
    // node in a mirrored document means data we cannot represent, so say so
    // rather than inventing a subject for it.
    throw new UnsupportedTermError(
      `Blank node in query results (_:${binding.value}); Atomic Data has no blank nodes.`,
    );
  }

  return {
    termType: 'literal',
    value: binding.value,
    datatype: binding.datatype,
    language: binding['xml:lang'],
  };
}

const isResults = (value: unknown): value is SparqlResults =>
  typeof value === 'object' && value !== null && 'results' in value;

/**
 * Reads `SELECT ?p ?o` results for one known subject.
 *
 * Skips blank-node objects rather than throwing: one unrepresentable value
 * should cost that value, not the whole resource. `onSkipped` reports them.
 */
export function bindingsToTriples(
  subject: string,
  raw: unknown,
  onSkipped?: (error: UnsupportedTermError) => void,
): Triple[] {
  if (!isResults(raw)) {
    return [];
  }

  const triples: Triple[] = [];

  for (const binding of raw.results?.bindings ?? []) {
    const predicate = binding.p;
    const object = binding.o;

    if (predicate === undefined || object === undefined) {
      continue;
    }

    if (predicate.type !== 'uri') {
      continue; // A non-IRI predicate is not expressible in RDF anyway.
    }

    try {
      triples.push({
        subject,
        predicate: predicate.value,
        object: toTerm(object),
      });
    } catch (error) {
      if (error instanceof UnsupportedTermError) {
        onSkipped?.(error);
        continue;
      }

      throw error;
    }
  }

  return triples;
}

/** Reads a single-variable `SELECT` (e.g. `SELECT DISTINCT ?s`). */
export function bindingsToValues(raw: unknown, variable: string): string[] {
  if (!isResults(raw)) {
    return [];
  }

  return (raw.results?.bindings ?? [])
    .map(binding => binding[variable]?.value)
    .filter((value): value is string => value !== undefined);
}
