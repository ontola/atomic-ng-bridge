/**
 * SPARQL generation.
 *
 * Every write is scoped to one subject inside one named graph, so a bridge
 * write can never touch anything it was not asked to touch. The graph IRI is
 * the NextGraph document nuri (`did:ng:<docId>`), which is how NextGraph
 * addresses a document's RDF content.
 */

import type { Term, Triple } from './types.js';
import { rdf, xsd } from './vocab.js';

/**
 * IRIs are written between angle brackets, so anything that could close the
 * bracket or start a new term has to be rejected. These characters are illegal
 * in an IRI anyway (RFC 3987), so this is a guard against injection through a
 * malformed subject, not a lossy escape.
 */
const ILLEGAL_IRI = /[\u0000-\u0020<>"{}|^`\\]/u;

export function serializeIri(value: string): string {
  if (ILLEGAL_IRI.test(value)) {
    throw new Error(
      `Refusing to serialize an IRI with illegal characters: ${value}`,
    );
  }

  return `<${value}>`;
}

export function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export function serializeTerm(term: Term): string {
  if (term.termType === 'iri') {
    return serializeIri(term.value);
  }

  const lexical = `"${escapeLiteral(term.value)}"`;

  if (term.language !== undefined) {
    return `${lexical}@${term.language}`;
  }

  // A plain literal is `xsd:string` in RDF 1.1; emitting the datatype would be
  // correct but noisier, and both forms read back identically.
  if (term.datatype === undefined || term.datatype === xsd.string) {
    return lexical;
  }

  if (term.datatype === rdf.langString) {
    throw new Error('rdf:langString literal without a language tag');
  }

  return `${lexical}^^${serializeIri(term.datatype)}`;
}

export const serializeTriple = (triple: Triple): string =>
  `${serializeIri(triple.subject)} ${serializeIri(
    triple.predicate,
  )} ${serializeTerm(triple.object)} .`;

const indent = (lines: string[]): string =>
  lines.map(line => `    ${line}`).join('\n');

/**
 * `DELETE`s everything the subject currently has in the graph.
 *
 * Destructive to predicates the bridge does not know about: if a NextGraph-native
 * app added a property to this subject, this removes it. Prefer
 * `deletePredicatesUpdate`, which is what the pusher uses by default.
 */
export function deleteSubjectUpdate(graph: string, subject: string): string {
  const g = serializeIri(graph);
  const s = serializeIri(subject);

  return `DELETE { GRAPH ${g} { ${s} ?p ?o } } WHERE { GRAPH ${g} { ${s} ?p ?o } }`;
}

/**
 * `DELETE`s only the listed predicates of one subject.
 *
 * This is what keeps the mirror from destroying data it did not write. A
 * NextGraph-native app is free to add its own predicates to a mirrored subject;
 * they survive every push, because the delete half of a replace only ever names
 * the predicates the bridge itself wrote last time plus the ones it is writing
 * now. Returns an empty string when there is nothing to delete.
 */
export function deletePredicatesUpdate(
  graph: string,
  subject: string,
  predicates: string[],
): string {
  if (predicates.length === 0) {
    return '';
  }

  const g = serializeIri(graph);
  const s = serializeIri(subject);
  const values = [...new Set(predicates)].sort().map(serializeIri).join(' ');

  return [
    `DELETE { GRAPH ${g} { ${s} ?p ?o } }`,
    `WHERE { GRAPH ${g} { ${s} ?p ?o } VALUES ?p { ${values} } }`,
  ].join('\n');
}

export function insertTriplesUpdate(graph: string, triples: Triple[]): string {
  return [
    `INSERT DATA {`,
    `  GRAPH ${serializeIri(graph)} {`,
    indent(triples.map(serializeTriple)),
    `  }`,
    `}`,
  ].join('\n');
}

/**
 * The two halves of a subject replace, as separate operations.
 *
 * Whether NextGraph's engine accepts them `;`-separated in one `sparql_update`
 * is unverified (`NEXTGRAPH-ISSUES.md` C2). Callers that cannot rely on it run
 * these sequentially, at the cost of two commits and a transient empty state
 * for the subject between them.
 */
export function replaceSubjectSteps(
  graph: string,
  subject: string,
  triples: Triple[],
  options: { deleteOnlyPredicates?: string[] } = {},
): string[] {
  const { deleteOnlyPredicates } = options;
  const deleteStep =
    deleteOnlyPredicates === undefined
      ? deleteSubjectUpdate(graph, subject)
      : deletePredicatesUpdate(graph, subject, deleteOnlyPredicates);

  const steps = deleteStep === '' ? [] : [deleteStep];

  if (triples.length > 0) {
    steps.push(insertTriplesUpdate(graph, triples));
  }

  return steps;
}

/** The same replace as one atomic update. Preferred when the engine accepts it. */
export const replaceSubjectUpdate = (
  graph: string,
  subject: string,
  triples: Triple[],
  options: { deleteOnlyPredicates?: string[] } = {},
): string => replaceSubjectSteps(graph, subject, triples, options).join(';\n');

/** Reads back every triple of one subject, for the pull direction. */
export function selectSubjectQuery(graph: string, subject: string): string {
  return [
    `SELECT ?p ?o WHERE {`,
    `  GRAPH ${serializeIri(graph)} { ${serializeIri(subject)} ?p ?o }`,
    `}`,
  ].join('\n');
}

/** Lists the distinct subjects in a graph, for a full pull. */
export function selectSubjectsQuery(graph: string): string {
  return [
    `SELECT DISTINCT ?s WHERE {`,
    `  GRAPH ${serializeIri(graph)} { ?s ?p ?o }`,
    `}`,
  ].join('\n');
}
