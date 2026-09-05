/**
 * Atomic Data <-> RDF triples.
 *
 * Atomic Data is a type-safe subset of RDF and Atomic properties are ordinary
 * dereferenceable URIs, so every predicate here is the Atomic property URI
 * itself. There is no parallel vocabulary and no semantic translation step.
 *
 * Three things plain triples cannot carry (array order, Loro documents, nested
 * resources) use the small bridge namespace in `vocab.ts`. Each is additive:
 * the data is always in plain triples too, so a native NextGraph consumer that
 * ignores the bridge namespace still sees real, queryable data.
 */

import { base64ToBytes, bytesToBase64 } from './base64.js';
import {
  type DatatypeResolver,
  type MappingResult,
  type MappingWarning,
  type Term,
  type Triple,
  iri,
  literal,
} from './types.js';
import {
  ATOMIC_IS_A,
  AtomicDatatype,
  bridge,
  rdf,
  xsd,
} from './vocab.js';

/** Anything `Resource.getPropVals()` can hand us. */
export type AtomicPropVals =
  | Map<string, unknown>
  | Record<string, unknown>;

const entriesOf = (propVals: AtomicPropVals): [string, unknown][] =>
  propVals instanceof Map ? [...propVals.entries()] : Object.entries(propVals);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

/** Guesses a datatype from the value, for when the property is not loaded. */
function inferDatatype(value: unknown): string {
  if (value instanceof Uint8Array) return AtomicDatatype.LORODOC;
  if (Array.isArray(value)) return AtomicDatatype.RESOURCEARRAY;
  if (typeof value === 'boolean') return AtomicDatatype.BOOLEAN;
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? AtomicDatatype.INTEGER
      : AtomicDatatype.FLOAT;
  }

  if (isPlainObject(value)) return AtomicDatatype.JSON;

  return AtomicDatatype.STRING;
}

/**
 * `timestamp` is milliseconds since the epoch. `toISOString()` always emits
 * exactly three fractional digits, so this is lossless in both directions.
 */
const timestampToIso = (ms: number): string => new Date(ms).toISOString();

export type ResourceToTriplesOptions = {
  /** Declared datatype per property. See `DatatypeResolver`. */
  datatypeOf?: DatatypeResolver;
  /**
   * Also emit `rdf:type` alongside Atomic's own `isA`. Native NextGraph queries
   * are written `?s a <Class>`, and this costs one derived triple per class.
   * Ignored on the way back.
   */
  emitRdfType?: boolean;
};

/**
 * Maps one Atomic resource to triples. Pure: no store, no network, no wasm.
 */
export function resourceToTriples(
  subject: string,
  propVals: AtomicPropVals,
  options: ResourceToTriplesOptions = {},
): MappingResult {
  const { datatypeOf, emitRdfType = true } = options;
  const triples: Triple[] = [];
  const warnings: MappingWarning[] = [];
  const order: Record<string, string[]> = {};

  const warn = (
    property: string,
    kind: MappingWarning['kind'],
    message: string,
  ) => warnings.push({ subject, property, kind, message });

  const push = (predicate: string, object: Term) =>
    triples.push({ subject, predicate, object });

  for (const [property, value] of entriesOf(propVals)) {
    if (value === undefined || value === null) {
      continue;
    }

    const datatype = datatypeOf?.(property) ?? inferDatatype(value);

    switch (datatype) {
      case AtomicDatatype.ATOMIC_URL: {
        if (typeof value === 'string') {
          push(property, iri(value));
        } else {
          // A nested resource: an Atomic resource inlined instead of linked.
          // Kept lossless as JSON-AD under a bridge datatype, but a native
          // NextGraph consumer cannot traverse into it.
          push(
            property,
            literal(JSON.stringify(value), bridge.nestedResource),
          );
          warn(
            property,
            'lossy-nested-resource',
            'Nested resource serialized as JSON-AD; not traversable as triples.',
          );
        }

        break;
      }

      case AtomicDatatype.RESOURCEARRAY: {
        if (!Array.isArray(value)) {
          warn(
            property,
            'unsupported-value',
            `Expected an array for resourceArray, got ${typeof value}.`,
          );
          break;
        }

        if (!value.every(member => typeof member === 'string')) {
          // Arrays of nested resources fall back to one JSON literal, so the
          // round trip stays exact. Opaque to native consumers; v1 supports
          // arrays of IRIs as real triples.
          push(property, literal(JSON.stringify(value), rdf.JSON));
          warn(
            property,
            'lossy-nested-resource',
            'Array contains nested resources; stored as a single JSON literal.',
          );
          break;
        }

        const members = value as string[];

        for (const member of members) {
          push(property, iri(member));
        }

        if (members.length > 1) {
          order[property] = members;
        }

        if (property === ATOMIC_IS_A && emitRdfType) {
          for (const member of members) {
            push(rdf.type, iri(member));
          }
        }

        break;
      }

      case AtomicDatatype.LOCALIZEDTEXT: {
        if (!isPlainObject(value)) {
          warn(
            property,
            'unsupported-value',
            `Expected an object for localizedText, got ${typeof value}.`,
          );
          break;
        }

        for (const [language, text] of Object.entries(value)) {
          push(property, literal(String(text), rdf.langString, language));
        }

        break;
      }

      case AtomicDatatype.LORODOC: {
        const base64 =
          value instanceof Uint8Array ? bytesToBase64(value) : String(value);
        push(property, literal(base64, bridge.loroDoc));
        break;
      }

      case AtomicDatatype.JSON: {
        push(property, literal(JSON.stringify(value), rdf.JSON));
        break;
      }

      case AtomicDatatype.BOOLEAN: {
        push(property, literal(String(Boolean(value)), xsd.boolean));
        break;
      }

      case AtomicDatatype.INTEGER: {
        push(property, literal(String(value), xsd.integer));
        break;
      }

      case AtomicDatatype.FLOAT: {
        push(property, literal(String(value), xsd.double));
        break;
      }

      case AtomicDatatype.TIMESTAMP: {
        if (typeof value !== 'number') {
          warn(
            property,
            'unsupported-value',
            `Expected a number for timestamp, got ${typeof value}.`,
          );
          break;
        }

        push(property, literal(timestampToIso(value), xsd.dateTime));
        break;
      }

      case AtomicDatatype.DATE: {
        push(property, literal(String(value), xsd.date));
        break;
      }

      case AtomicDatatype.URI: {
        push(property, literal(String(value), xsd.anyURI));
        break;
      }

      case AtomicDatatype.STRING:
      case AtomicDatatype.SLUG:
      case AtomicDatatype.MARKDOWN: {
        push(property, literal(String(value)));
        break;
      }

      default: {
        // An unknown datatype still round-trips as a string rather than being
        // dropped, but say so: silent coercion is how data goes missing.
        push(property, literal(String(value)));
        warn(
          property,
          'unknown-datatype',
          `Unknown datatype ${datatype}; stored as a plain string literal.`,
        );
      }
    }
  }

  if (Object.keys(order).length > 0) {
    push(bridge.arrayOrder, literal(JSON.stringify(order), rdf.JSON));
  }

  return { triples, warnings };
}

export type TriplesToPropValsResult = {
  propVals: Record<string, unknown>;
  warnings: MappingWarning[];
};

/** Restores array order, appending members the order map does not mention. */
function applyOrder(members: string[], ordered: string[] | undefined): string[] {
  if (!ordered) {
    // Deterministic rather than arbitrary: a NextGraph-native writer that adds
    // a member without touching the bookkeeping triple gets a stable position.
    return [...members].sort();
  }

  const known = ordered.filter(member => members.includes(member));
  const extra = members.filter(member => !ordered.includes(member)).sort();

  return [...known, ...extra];
}

function literalToValue(
  term: Extract<Term, { termType: 'literal' }>,
): unknown {
  switch (term.datatype) {
    case xsd.boolean:
      return term.value === 'true';
    case xsd.integer:
      return Number.parseInt(term.value, 10);
    case xsd.double:
      return Number.parseFloat(term.value);
    case xsd.dateTime:
      return Date.parse(term.value);
    case rdf.JSON:
      return JSON.parse(term.value);
    case bridge.loroDoc:
      return base64ToBytes(term.value);
    case bridge.nestedResource:
      return JSON.parse(term.value);
    default:
      return term.value;
  }
}

/**
 * Maps triples for one subject back to Atomic prop/vals.
 *
 * `datatypeOf` is authoritative where available, because several Atomic
 * datatypes share one XSD datatype. Without it the literal's own datatype is
 * used, which is correct for everything except telling `string` from `slug` /
 * `markdown` and `atomicURL` from `uri`.
 */
export function triplesToPropVals(
  triples: Triple[],
  options: { datatypeOf?: DatatypeResolver } = {},
): TriplesToPropValsResult {
  const { datatypeOf } = options;
  const warnings: MappingWarning[] = [];
  const byProperty = new Map<string, Term[]>();
  let order: Record<string, string[]> = {};

  for (const triple of triples) {
    if (triple.predicate === rdf.type) {
      continue; // Derived from `isA` on the way out; never read back.
    }

    if (triple.predicate === bridge.atomicSubject) {
      continue; // The subject's own alias record (alias.ts); not a property.
    }

    if (triple.predicate === bridge.arrayOrder) {
      if (triple.object.termType === 'literal') {
        order = JSON.parse(triple.object.value) as Record<string, string[]>;
      }

      continue;
    }

    const existing = byProperty.get(triple.predicate);

    if (existing) {
      existing.push(triple.object);
    } else {
      byProperty.set(triple.predicate, [triple.object]);
    }
  }

  const propVals: Record<string, unknown> = {};

  for (const [property, terms] of byProperty) {
    const datatype = datatypeOf?.(property);
    const languageTagged = terms.filter(
      term => term.termType === 'literal' && term.language !== undefined,
    );

    if (
      datatype === AtomicDatatype.LOCALIZEDTEXT ||
      (datatype === undefined && languageTagged.length > 0)
    ) {
      const translations: Record<string, string> = {};

      for (const term of terms) {
        if (term.termType === 'literal' && term.language !== undefined) {
          translations[term.language] = term.value;
        } else {
          warnings.push({
            subject: triples[0]?.subject ?? '',
            property,
            kind: 'unsupported-value',
            message: 'Untagged literal on a localizedText property; skipped.',
          });
        }
      }

      propVals[property] = translations;
      continue;
    }

    const isArray =
      datatype === AtomicDatatype.RESOURCEARRAY ||
      (datatype === undefined && terms.length > 1);

    if (isArray) {
      const members = terms.map(term =>
        term.termType === 'iri' ? term.value : String(literalToValue(term)),
      );

      // A single JSON literal is the nested-resource fallback from the other
      // direction, not a one-member array.
      if (
        terms.length === 1 &&
        terms[0]!.termType === 'literal' &&
        terms[0]!.datatype === rdf.JSON
      ) {
        propVals[property] = literalToValue(
          terms[0] as Extract<Term, { termType: 'literal' }>,
        );
        continue;
      }

      propVals[property] = applyOrder(members, order[property]);
      continue;
    }

    const term = terms[0]!;

    if (term.termType === 'iri') {
      propVals[property] = term.value;
      continue;
    }

    propVals[property] = literalToValue(term);
  }

  return { propVals, warnings };
}
