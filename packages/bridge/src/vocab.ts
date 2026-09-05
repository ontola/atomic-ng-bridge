/**
 * Vocabulary used by the mapping.
 *
 * Atomic property URIs are used directly as RDF predicates (they are real,
 * dereferenceable URIs), so the only vocabulary defined here is XSD, the two
 * RDF terms we emit, and the small bridge-private namespace for the three
 * things plain triples cannot carry.
 */

export const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const xsd = {
  string: `${XSD}string`,
  integer: `${XSD}integer`,
  double: `${XSD}double`,
  boolean: `${XSD}boolean`,
  date: `${XSD}date`,
  dateTime: `${XSD}dateTime`,
  anyURI: `${XSD}anyURI`,
} as const;

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

export const rdf = {
  type: `${RDF}type`,
  JSON: `${RDF}JSON`,
  langString: `${RDF}langString`,
} as const;

/** Atomic's own `isA`, which we also mirror onto `rdf:type`. */
export const ATOMIC_IS_A = 'https://atomicdata.dev/properties/isA';

/**
 * Bridge-private namespace. Everything here is bookkeeping a native NextGraph
 * consumer can ignore: the data itself is always in plain triples alongside it.
 */
export const BRIDGE_NS = 'https://atomicdata.dev/ng-bridge/';

export const bridge = {
  /**
   * One triple per subject: a JSON object of `{ propertyIri: [memberIri, ...] }`
   * restoring `resourceArray` order, which RDF itself cannot express.
   */
  arrayOrder: `${BRIDGE_NS}arrayOrder`,
  /** A Loro document, base64. Opaque to native consumers; round-trips exactly. */
  loroDoc: `${BRIDGE_NS}loroDoc`,
  /** An Atomic nested resource, serialized as JSON-AD. See mapping.ts. */
  nestedResource: `${BRIDGE_NS}nestedResource`,
  /**
   * One triple per aliased subject: the `did:ad:` subject this NextGraph
   * subject stands for. See alias.ts. Never becomes a property locally.
   */
  atomicSubject: `${BRIDGE_NS}atomicSubject`,
} as const;

/** Atomic datatype URIs. Copied deliberately: the mapping core stays dependency-free. */
export const AtomicDatatype = {
  ATOMIC_URL: 'https://atomicdata.dev/datatypes/atomicURL',
  BOOLEAN: 'https://atomicdata.dev/datatypes/boolean',
  DATE: 'https://atomicdata.dev/datatypes/date',
  FLOAT: 'https://atomicdata.dev/datatypes/float',
  INTEGER: 'https://atomicdata.dev/datatypes/integer',
  MARKDOWN: 'https://atomicdata.dev/datatypes/markdown',
  RESOURCEARRAY: 'https://atomicdata.dev/datatypes/resourceArray',
  SLUG: 'https://atomicdata.dev/datatypes/slug',
  STRING: 'https://atomicdata.dev/datatypes/string',
  TIMESTAMP: 'https://atomicdata.dev/datatypes/timestamp',
  JSON: 'https://atomicdata.dev/datatypes/json',
  URI: 'https://atomicdata.dev/datatypes/uri',
  LORODOC: 'https://atomicdata.dev/datatypes/lorodoc',
  LOCALIZEDTEXT: 'https://atomicdata.dev/datatypes/localizedText',
} as const;

export type AtomicDatatypeUri =
  (typeof AtomicDatatype)[keyof typeof AtomicDatatype];

/**
 * Properties the mirror must never carry.
 *
 * `lastCommit` changes on *every* save, so mirroring it makes the two sides
 * chase each other forever: pull applies a change, the resulting local save
 * mints a new `lastCommit`, push writes that to NextGraph, the document
 * subscription fires, pull applies it, and so on without end. Observed live in
 * the data-browser integration — it wedged the browser tab.
 *
 * The general rule: mirror the user's data, never the local commit system's
 * bookkeeping. Commit metadata is per-store by definition and means nothing on
 * the other side.
 */
export const VOLATILE_PROPERTIES: readonly string[] = [
  'https://atomicdata.dev/properties/lastCommit',
];

export const isVolatileProperty = (property: string): boolean =>
  VOLATILE_PROPERTIES.includes(property);
