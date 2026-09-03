/** RDF terms and triples, the neutral currency between Atomic and NextGraph. */

export type IriTerm = { termType: 'iri'; value: string };

export type LiteralTerm = {
  termType: 'literal';
  value: string;
  /** Datatype IRI. Absent means `xsd:string` (or `rdf:langString` when `language` is set). */
  datatype?: string;
  /** BCP 47 tag. Mutually exclusive with a non-string `datatype`, per RDF. */
  language?: string;
};

export type Term = IriTerm | LiteralTerm;

export type Triple = {
  subject: string;
  predicate: string;
  object: Term;
};

export const iri = (value: string): IriTerm => ({ termType: 'iri', value });

export const literal = (
  value: string,
  datatype?: string,
  language?: string,
): LiteralTerm => ({ termType: 'literal', value, datatype, language });

/**
 * Resolves a property's declared Atomic datatype. Authoritative on the way back
 * from RDF, where several Atomic datatypes share one XSD datatype (`string`,
 * `slug` and `markdown` all land on `xsd:string`).
 *
 * Returns `undefined` when the property resource has not been loaded; the
 * reverse mapping then falls back to reading the literal's own datatype.
 */
export type DatatypeResolver = (propertyIri: string) => string | undefined;

/** What the bridge could not represent faithfully, surfaced rather than swallowed. */
export type MappingWarning = {
  subject: string;
  property: string;
  /** Machine-readable so callers can count kinds without parsing prose. */
  kind: 'unsupported-value' | 'unknown-datatype' | 'lossy-nested-resource';
  message: string;
};

export type MappingResult = {
  triples: Triple[];
  warnings: MappingWarning[];
};
