/**
 * The seams the sync core talks through.
 *
 * Nothing here imports `@tomic/lib` or `@ng-org/*`. The core is driven by these
 * three ports, so it runs in plain vitest, and swapping the NextGraph transport
 * (embedded engine now, an iframe-backed one if M0 forces it) touches no sync
 * logic. See PLAN.md section 4.
 */

import type { DatatypeResolver, Triple } from './types.js';

/** One Atomic resource, as the push side needs to see it. */
export type AtomicSnapshot = {
  subject: string;
  propVals: Record<string, unknown>;
  /**
   * Datatypes for this snapshot's properties, resolved by the adapter before
   * handing the snapshot over. Property resources load asynchronously; keeping
   * that await at the edge keeps the mapping itself sync and pure.
   */
  datatypeOf: DatatypeResolver;
};

/** The Atomic side: what changed, and what it looks like now. */
export type AtomicSource = {
  /**
   * Calls back with every subject that changed locally. Returns an unsubscriber.
   * The push side treats this as a hint: it always re-reads the resource, so a
   * duplicate or spurious notification costs a read, never correctness.
   */
  onChanged: (callback: (subject: string) => void) => () => void;
  /** Resolves to `undefined` when the resource no longer exists. */
  getSnapshot: (subject: string) => Promise<AtomicSnapshot | undefined>;
};

export type NgSubscription = { close: () => void };

/** The NextGraph side. Four methods, per PLAN.md section 4. */
export type NgTransport = {
  query: (sparql: string) => Promise<Triple[]>;
  /**
   * Runs one SPARQL update. Callers pass operations one at a time unless
   * `supportsMultiOperationUpdate` is set on the pusher, because whether the
   * engine accepts `;`-separated operations is unverified
   * (`NEXTGRAPH-ISSUES.md` C2).
   */
  update: (sparql: string) => Promise<void>;
  subscribe: (callback: () => void) => Promise<NgSubscription>;
  close: () => Promise<void>;
};

/**
 * Durable "what does NextGraph already have", keyed per subject.
 *
 * `@tomic/lib` tracks nothing like this, so it is genuinely new state. The
 * stored value is a content hash of the triples last known to be in NextGraph
 * for that subject (see `canonical.ts`), which is what makes both idempotent
 * resume and echo suppression fall out of one mechanism: a push whose hash
 * already matches is a no-op, and that is exactly what a pulled write looks
 * like once the pull side records what it applied.
 */
export type CursorEntry = {
  /** Content hash of the triples NextGraph is known to hold for this subject. */
  hash: string;
  /**
   * The predicates the bridge wrote. Kept so the delete half of the next
   * replace can name them explicitly, leaving predicates a NextGraph-native app
   * added to the same subject untouched.
   */
  predicates: string[];
};

export type CursorStore = {
  get: (subject: string) => Promise<CursorEntry | undefined>;
  set: (subject: string, entry: CursorEntry) => Promise<void>;
  delete: (subject: string) => Promise<void>;
};
