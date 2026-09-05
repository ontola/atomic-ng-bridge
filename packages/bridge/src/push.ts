/**
 * Push: Atomic -> NextGraph.
 *
 * Watches local changes, maps each changed subject to triples, and issues a
 * subject-scoped replace. Three properties this has to hold, because getting
 * any of them wrong is silent data loss rather than a crash:
 *
 * - **Idempotent.** A replace scoped to one subject is idempotent by
 *   construction, so a tab killed mid-push resumes by re-pushing, never by
 *   duplicating. The cursor is recorded only after the write lands, so the
 *   failure mode is "push twice", not "skip once".
 * - **Echo-free.** The cursor is a content hash of what NextGraph already has.
 *   A write that came *from* NextGraph therefore hashes to what is already
 *   recorded, and the push side skips it, so push and pull cannot feed each
 *   other. This is checked by test, because the failure is an infinite loop.
 * - **Ordered and single-flight.** Subjects are pushed one at a time and
 *   flushes are chained, so two overlapping flushes can never interleave two
 *   halves of one replace against the same engine.
 */

import { aliasResourceTriples, ngSubjectFor } from './alias.js';
import { contentHash } from './canonical.js';
import { resourceToTriples } from './mapping.js';
import type {
  AtomicSource,
  CursorEntry,
  CursorStore,
  NgTransport,
} from './ports.js';
import {
  deletePredicatesUpdate,
  deleteSubjectUpdate,
  insertTriplesUpdate,
  replaceSubjectSteps,
  replaceSubjectUpdate,
} from './sparql.js';
import type { MappingWarning } from './types.js';

export type PushError = { subject: string; error: unknown };

export type FlushResult = {
  /** Subjects whose triples were written to NextGraph. */
  pushed: string[];
  /** Subjects NextGraph already had, byte for byte. Includes pulled writes. */
  skipped: string[];
  /** Subjects removed locally, and so removed from the graph. */
  deleted: string[];
  /** Subjects left queued for the next flush. */
  failed: string[];
};

export type PusherOptions = {
  /** The NextGraph document nuri this drive mirrors into. */
  graph: string;
  source: AtomicSource;
  transport: NgTransport;
  cursors: CursorStore;
  /**
   * Send the delete and the insert as one `;`-separated update.
   *
   * On by default: the engine accepts it, verified against a
   * real document (`NEXTGRAPH-ISSUES.md` C2). That makes a replace one commit
   * with no window in which the subject has no properties. Set it false for an
   * engine or transport that cannot do it; the two-step path still works.
   */
  supportsMultiOperationUpdate?: boolean;
  emitRdfType?: boolean;
  /**
   * Only delete predicates the bridge itself wrote, so a NextGraph-native app
   * can add its own properties to a mirrored subject without the next push
   * destroying them. On by default; turning it off makes every replace
   * authoritative over the whole subject, including data the bridge never wrote.
   */
  preserveForeignPredicates?: boolean;
  onWarning?: (warning: MappingWarning) => void;
  onError?: (error: PushError) => void;
  /** Auto-flush after a quiet period. Off in tests, which flush explicitly. */
  autoFlush?: boolean;
  debounceMs?: number;
};

export type Pusher = {
  /** Subscribes to local changes. Returns an unsubscriber. */
  start: () => () => void;
  /** Queues a subject by hand. `start()` does this for every local change. */
  notifyChanged: (subject: string) => void;
  /** Pushes everything queued. Safe to call concurrently; flushes are chained. */
  flush: () => Promise<FlushResult>;
  /** How many subjects are waiting. */
  readonly pending: number;
};

const emptyResult = (): FlushResult => ({
  pushed: [],
  skipped: [],
  deleted: [],
  failed: [],
});

export function createPusher(options: PusherOptions): Pusher {
  const {
    graph,
    source,
    transport,
    cursors,
    supportsMultiOperationUpdate = true,
    emitRdfType = true,
    preserveForeignPredicates = true,
    onWarning,
    onError,
    autoFlush = true,
    debounceMs = 50,
  } = options;

  const queue = new Set<string>();
  let chain: Promise<FlushResult> = Promise.resolve(emptyResult());
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runUpdates = async (updates: string[]): Promise<void> => {
    for (const update of updates) {
      await transport.update(update);
    }
  };

  const pushSubject = async (
    subject: string,
    result: FlushResult,
  ): Promise<void> => {
    const snapshot = await source.getSnapshot(subject);

    const previous = await cursors.get(subject);
    // The document knows this resource by its NextGraph subject (alias.ts);
    // cursors stay keyed by the Atomic one, which is what the source reports.
    const ngSubject = ngSubjectFor(subject, graph);

    if (snapshot === undefined) {
      // Gone locally. The mirror of that is removing what we put there, and
      // only that: a NextGraph-native app's own predicates on this subject are
      // not ours to delete. With no cursor we know of nothing we wrote, so
      // there is nothing to remove.
      const update = preserveForeignPredicates
        ? deletePredicatesUpdate(graph, ngSubject, previous?.predicates ?? [])
        : deleteSubjectUpdate(graph, ngSubject);

      if (update !== '') {
        await transport.update(update);
      }

      await cursors.delete(subject);
      result.deleted.push(subject);

      return;
    }

    const mapped = resourceToTriples(subject, snapshot.propVals, {
      datatypeOf: snapshot.datatypeOf,
      emitRdfType,
    });

    for (const warning of mapped.warnings) {
      onWarning?.(warning);
    }

    // Hash what the document will hold, alias record included: the pull side
    // hashes what it reads back, and the two must agree for echo suppression.
    const { triples } = aliasResourceTriples(subject, mapped.triples, graph);
    const hash = contentHash(triples);

    if (previous?.hash === hash) {
      result.skipped.push(subject);

      return;
    }

    const predicates = [...new Set(triples.map(triple => triple.predicate))];
    // Everything we are about to write, plus everything we wrote last time and
    // are not writing now (a property the user just cleared).
    const deleteOnlyPredicates = preserveForeignPredicates
      ? [...new Set([...(previous?.predicates ?? []), ...predicates])]
      : undefined;

    if (supportsMultiOperationUpdate) {
      await transport.update(
        replaceSubjectUpdate(graph, ngSubject, triples, { deleteOnlyPredicates }),
      );
    } else {
      await runUpdates(
        replaceSubjectSteps(graph, ngSubject, triples, { deleteOnlyPredicates }),
      );
    }

    // Only now: a cursor written before the update would turn a failed push
    // into a permanently skipped subject.
    await cursors.set(subject, { hash, predicates });
    result.pushed.push(subject);
  };

  const doFlush = async (): Promise<FlushResult> => {
    const result = emptyResult();
    const subjects = [...queue];
    queue.clear();

    for (const subject of subjects) {
      try {
        await pushSubject(subject, result);
      } catch (error) {
        // Re-queue rather than drop. The replace is idempotent, so retrying a
        // half-applied push is safe.
        queue.add(subject);
        result.failed.push(subject);
        onError?.({ subject, error });
      }
    }

    return result;
  };

  const flush = (): Promise<FlushResult> => {
    chain = chain.then(doFlush, doFlush);

    return chain;
  };

  const scheduleFlush = () => {
    if (!autoFlush || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
  };

  const notifyChanged = (subject: string) => {
    queue.add(subject);
    scheduleFlush();
  };

  return {
    start: () => {
      const unsubscribe = source.onChanged(notifyChanged);

      return () => {
        unsubscribe();

        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    notifyChanged,
    flush,
    get pending() {
      return queue.size;
    },
  };
}

/**
 * A `CursorStore` in memory. Real deployments persist this (IndexedDB, per
 * drive); losing it is not corruption, it just means the next flush re-pushes
 * every subject it sees, which the idempotent replace makes safe.
 */
export function createMemoryCursorStore(
  initial: Record<string, CursorEntry> = {},
): CursorStore & { snapshot: () => Record<string, CursorEntry> } {
  const map = new Map(Object.entries(initial));

  return {
    get: async subject => map.get(subject),
    set: async (subject, entry) => {
      map.set(subject, entry);
    },
    delete: async subject => {
      map.delete(subject);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

/** Re-exported for adapters that build their own updates. */
export { insertTriplesUpdate };
