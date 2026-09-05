/**
 * Pull: NextGraph -> Atomic.
 *
 * The mirror image of `push.ts`, and it shares the cursor with it, which is
 * what keeps the two from feeding each other. After applying a subject, pull
 * records the hash of exactly what it applied; the push side then sees a hash
 * it already has and skips. Neither side needs to know the other exists.
 *
 * Writes go through the Atomic side's ordinary commit path (`set` then `save`),
 * not a forged commit: history, undo and every live subscriber in the app then
 * behave normally, with no special-casing for bridged data.
 */

import {
  type AliasMap,
  isDriveResource,
  ngSubjectFor,
  unaliasResourceTriples,
} from './alias.js';
import { contentHash } from './canonical.js';
import { triplesToPropVals } from './mapping.js';
import type { CursorStore, NgTransport } from './ports.js';
import {
  selectAliasesQuery,
  selectSubjectQuery,
  selectSubjectsQuery,
} from './sparql.js';
import type { DatatypeResolver, MappingWarning } from './types.js';
import { bridge } from './vocab.js';

/** A transport that can read one variable out of a query. The engine's can. */
type ValueTransport = NgTransport & {
  queryValues?: (sparql: string, variable: string) => Promise<string[]>;
};

/** The Atomic side, as the pull direction needs it. */
export type AtomicSink = {
  /**
   * Applies NextGraph's version of one subject locally, as an ordinary commit.
   * Called only when something actually changed.
   */
  applyResource: (
    subject: string,
    propVals: Record<string, unknown>,
  ) => Promise<void>;
  /** Removes a resource that is gone from the graph. */
  removeResource: (subject: string) => Promise<void>;
  /** Declared datatypes, so string subtypes and `atomicURL` survive the trip. */
  datatypeOf: DatatypeResolver;
  /**
   * Loads the property resources for these predicates, if they are not loaded.
   * Called before mapping, so `datatypeOf` is warm by the time it is used.
   */
  warmDatatypes?: (properties: string[]) => Promise<void>;
};

export type PullError = { subject: string; error: unknown };

export type PullResult = {
  /** Subjects whose local copy was updated from NextGraph. */
  applied: string[];
  /** Subjects already identical locally. */
  unchanged: string[];
  /** Subjects gone from the graph, and so removed locally. */
  removed: string[];
  failed: string[];
};

export type PullerOptions = {
  graph: string;
  sink: AtomicSink;
  transport: NgTransport;
  /** The same store the pusher uses. Sharing it is what suppresses echoes. */
  cursors: CursorStore;
  /**
   * Subjects the bridge is responsible for.
   *
   * The default excludes the document's own nuri, which is a subject in its own
   * graph: `findOrCreateDocument` writes `<doc> a <AppClass>` there so the
   * document can be found again, and materializing that bookkeeping triple as a
   * local Atomic resource is never right. A NextGraph document can hold other
   * subjects that are not ours either; that is what this is for.
   */
  shouldPull?: (subject: string) => boolean;
  /**
   * How long to wait after a document notification before re-reading, and how
   * long to keep collapsing further notifications into that one read.
   *
   * This is not a nicety. `doc_subscribe` is document-grained: it says
   * "something changed", not what, so every notification costs a subject
   * listing plus one query per subject. Our own pushes trigger notifications
   * too, so without coalescing, one edit to a drive of N resources costs O(N)
   * queries, and a burst of edits saturates the main thread — observed live in
   * the data-browser integration where it froze the tab.
   */
  pullDebounceMs?: number;
  onWarning?: (warning: MappingWarning) => void;
  onError?: (error: PullError) => void;
};

export type Puller = {
  /** Subscribes to the document. Returns an unsubscriber. */
  start: () => Promise<() => void>;
  /** Pulls every subject in the document once. */
  pullAll: () => Promise<PullResult>;
  /** Pulls specific subjects. */
  pull: (subjects: string[]) => Promise<PullResult>;
};

const emptyResult = (): PullResult => ({
  applied: [],
  unchanged: [],
  removed: [],
  failed: [],
});

export function createPuller(options: PullerOptions): Puller {
  const {
    graph,
    sink,
    transport,
    cursors,
    shouldPull = subject => subject !== graph && !graph.startsWith(subject),
    pullDebounceMs = 750,
    onWarning,
    onError,
  } = options;

  let chain: Promise<PullResult> = Promise.resolve(emptyResult());
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let missedWhileRunning = false;

  const pullSubject = async (
    requested: string,
    aliases: AliasMap,
    result: PullResult,
  ): Promise<void> => {
    // Callers may name either side: the document lists NextGraph subjects, a
    // local caller knows the Atomic one. The document is read by the former;
    // cursors and the sink work with the latter (alias.ts).
    const ngSubject = isDriveResource(requested)
      ? ngSubjectFor(requested, graph)
      : requested;
    const raw = await transport.query(selectSubjectQuery(graph, ngSubject));

    if (raw.length === 0) {
      const subject = isDriveResource(requested)
        ? requested
        : (aliases.get(ngSubject) ?? ngSubject);
      const known = await cursors.get(subject);

      // Nothing in the graph. Only meaningful if we had something there before:
      // otherwise this is a subject we were told about but never mirrored, and
      // deleting a local resource on that basis would be destructive.
      if (known === undefined) {
        result.unchanged.push(subject);

        return;
      }

      await sink.removeResource(subject);
      await cursors.delete(subject);
      result.removed.push(subject);

      return;
    }

    // Hash the document's own terms, before mapping links back: this is what
    // the push side hashes too, so a pulled write is not pushed again.
    const hash = contentHash(raw);
    const { subject, triples } = unaliasResourceTriples(ngSubject, raw, aliases);

    if ((await cursors.get(subject))?.hash === hash) {
      // Already applied, or we pushed exactly this. Either way, nothing to do,
      // and this is the check that stops a pull from re-triggering a push.
      result.unchanged.push(subject);

      return;
    }

    const predicates = [...new Set(triples.map(triple => triple.predicate))];
    await sink.warmDatatypes?.(
      predicates.filter(predicate => predicate !== bridge.atomicSubject),
    );

    const { propVals, warnings } = triplesToPropVals(triples, {
      datatypeOf: sink.datatypeOf,
    });

    for (const warning of warnings) {
      onWarning?.(warning);
    }

    await sink.applyResource(subject, propVals);

    // After the local write lands, not before: a cursor recorded early would
    // make a failed apply look like a completed one, and the change would never
    // be pulled again.
    await cursors.set(subject, { hash, predicates });
    result.applied.push(subject);
  };

  const run = async (subjects: string[]): Promise<PullResult> => {
    const result = emptyResult();
    const wanted = subjects.filter(shouldPull);
    const aliases =
      wanted.length === 0
        ? new Map()
        : await loadAliases(transport, graph, error =>
            onError?.({ subject: graph, error }),
          );

    for (const listed of wanted) {
      try {
        await pullSubject(listed, aliases, result);
      } catch (error) {
        // Reported under the Atomic subject, like every other outcome.
        const subject = aliases.get(listed) ?? listed;
        result.failed.push(subject);
        onError?.({ subject, error });
      }
    }

    return result;
  };

  const queue = (subjects: string[]): Promise<PullResult> => {
    const next = () => run(subjects);
    chain = chain.then(next, next);

    return chain;
  };

  const pullAll = async (): Promise<PullResult> => {
    if (running) {
      // A full read is already in flight. Anything that changed meanwhile is
      // picked up by the follow-up read below, so this notification collapses
      // into that one rather than starting a competing sweep.
      missedWhileRunning = true;

      return chain;
    }

    running = true;

    try {
      const subjects = await listSubjects(transport, graph);
      const result = await queue(subjects);

      return result;
    } finally {
      running = false;

      if (missedWhileRunning) {
        missedWhileRunning = false;
        schedulePullAll();
      }
    }
  };

  /** Coalesces a burst of notifications into one read. */
  const schedulePullAll = () => {
    if (scheduled !== undefined) {
      return;
    }

    scheduled = setTimeout(() => {
      scheduled = undefined;
      void pullAll();
    }, pullDebounceMs);
  };

  return {
    pull: subjects => queue(subjects),
    pullAll,

    start: async () => {
      // `doc_subscribe` says "something in this document changed", not what.
      // So a change means re-reading the document's subjects. That is the cost
      // of the subscription being document-grained rather than subject-grained.
      const subscription = await transport.subscribe(() => {
        schedulePullAll();
      });

      return () => {
        if (scheduled !== undefined) {
          clearTimeout(scheduled);
          scheduled = undefined;
        }

        subscription.close();
      };
    },
  };
}

/**
 * Lists the subjects in the document.
 *
 * Separate from the transport so the generic `query` stays about triples: this
 * needs a single-variable result, and transports that can read one (the engine
 * transport can) should implement `queryValues`.
 */
async function listSubjects(
  transport: ValueTransport,
  graph: string,
): Promise<string[]> {
  const sparql = selectSubjectsQuery(graph);

  if (transport.queryValues !== undefined) {
    return transport.queryValues(sparql, 's');
  }

  // Fallback: read it as triples and take the subjects. Works, but a transport
  // that can read bindings directly should say so.
  const triples = await transport.query(sparql);

  return [...new Set(triples.map(triple => triple.subject))];
}

/**
 * Reads every alias record in the document, in one query, so links between
 * mirrored resources map back to Atomic subjects without a query per link.
 *
 * If the read fails the map is empty rather than the pull aborted: a subject's
 * own origin is still read from its triples, so the resource itself lands
 * under the right Atomic subject; only links to other aliased subjects would
 * then stay as NextGraph IRIs until the next successful pull.
 */
async function loadAliases(
  transport: NgTransport,
  graph: string,
  onError: (error: unknown) => void,
): Promise<AliasMap> {
  const aliases = new Map<string, string>();

  try {
    const rows = await transport.query(
      selectAliasesQuery(graph, bridge.atomicSubject),
    );

    for (const row of rows) {
      if (row.object.termType === 'iri') {
        aliases.set(row.predicate, row.object.value);
      }
    }
  } catch (error) {
    onError(error);
  }

  return aliases;
}
