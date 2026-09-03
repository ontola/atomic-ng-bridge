/**
 * The one file that knows about `@tomic/lib`.
 *
 * Everything else in this package is driven by the ports in `ports.ts`, so the
 * library's API surface is pinned down here and nowhere else. That matters more
 * than usual while we develop against an unpublished build (PLAN.md section 10).
 */

import {
  StoreEvents,
  type Resource,
  type Store,
} from '@tomic/lib';
import type { AtomicSnapshot, AtomicSource } from './ports.js';
import type { DatatypeResolver } from './types.js';
import { isVolatileProperty } from './vocab.js';

export type AtomicStoreSourceOptions = {
  store: Store;
  /**
   * How long to wait for a resource to load before giving up on this round.
   *
   * `Store.getResource` on a subject it cannot resolve locally waits on a
   * network request that, with no server, only ends in its own 10s timeout.
   * Pushes are sequential, so one such subject stalls every other pending
   * change behind it. Failing fast and retrying next flush is strictly better.
   */
  snapshotTimeoutMs?: number;
  /**
   * Which resources belong in the mirror. Called for every local change.
   *
   * There is deliberately no drive-scoping built in: `Store`'s own drive
   * resolution is private, and a bridge that guesses its scope wrong either
   * leaks resources into someone else's document or silently mirrors nothing.
   * The app knows its drive; it passes a predicate.
   */
  shouldMirror?: (subject: string) => boolean;
};

/**
 * A datatype cache.
 *
 * Property resources load asynchronously, but the mapping is sync by design.
 * The gap is closed here: every property a snapshot mentions is loaded before
 * the snapshot is handed over, so the resolver the mapping sees never misses.
 */
class DatatypeCache {
  private readonly cache = new Map<string, string | undefined>();

  constructor(private readonly store: Store) {}

  public async warm(properties: string[]): Promise<void> {
    await Promise.all(
      properties
        .filter(property => !this.cache.has(property))
        .map(async property => {
          try {
            const loaded = await this.store.getProperty(property);
            // A property that failed to load is cached as `undefined` rather
            // than retried per push: the mapping falls back to inferring from
            // the value, which is right for everything except string subtypes.
            this.cache.set(
              property,
              loaded.error === undefined ? loaded.datatype : undefined,
            );
          } catch {
            this.cache.set(property, undefined);
          }
        }),
    );
  }

  public readonly resolver: DatatypeResolver = property =>
    this.cache.get(property);
}

/** Wraps a `Store` as the push side's `AtomicSource`. */
class ResourceUnavailableError extends Error {}

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ResourceUnavailableError(`${what} timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export function createAtomicStoreSource(
  options: AtomicStoreSourceOptions,
): AtomicSource {
  const { store, shouldMirror = () => true, snapshotTimeoutMs = 2000 } = options;
  const datatypes = new DatatypeCache(store);
  /**
   * Subjects the store told us were removed.
   *
   * This is the *only* evidence that a resource is gone, and the distinction
   * matters more than it looks: "removed" means delete it from NextGraph, while
   * "did not load" means try again later. Treating the second as the first
   * deletes a user's data because their network was slow.
   */
  const removed = new Set<string>();

  return {
    onChanged: callback => {
      const emit = (subject: string) => {
        if (shouldMirror(subject)) {
          callback(subject);
        }
      };

      // `ResourceUpdated` covers local commits and remote pushes both; the
      // pusher re-reads and hashes anyway, so an extra notification is a wasted
      // read, never a wrong write. `ResourceSaved` is kept because it is the
      // one event that fires on an explicit user save.
      const unsubscribers = [
        store.on(StoreEvents.ResourceUpdated, (resource: Resource) =>
          emit(resource.subject),
        ),
        store.on(StoreEvents.ResourceSaved, (resource: Resource) =>
          emit(resource.subject),
        ),
        store.on(StoreEvents.ResourceRemoved, (subject: string) => {
          removed.add(subject);
          emit(subject);
        }),
      ];

      return () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };
    },

    getSnapshot: async (subject): Promise<AtomicSnapshot | undefined> => {
      if (removed.has(subject)) {
        return undefined; // Genuinely gone: the store said so.
      }

      const resource = await withTimeout(
        store.getResource(subject),
        snapshotTimeoutMs,
        subject,
      );

      if (!resource.isReady()) {
        // Not loaded, or errored. NOT the same as deleted: returning undefined
        // here would have the pusher delete the subject from NextGraph. Throw
        // so the pusher re-queues it instead.
        throw new ResourceUnavailableError(
          `${subject} is not loaded; not treating that as a deletion`,
        );
      }

      // Commit bookkeeping is dropped here rather than in the mapping: it is an
      // Atomic-side concern, and mirroring it loops the two systems forever
      // (see `VOLATILE_PROPERTIES`).
      const propVals = Object.fromEntries(
        Object.entries(resource.getPropVals()).filter(
          ([property]) => !isVolatileProperty(property),
        ),
      );

      if (Object.keys(propVals).length === 0) {
        throw new ResourceUnavailableError(
          `${subject} has no properties yet; not treating that as a deletion`,
        );
      }

      await datatypes.warm(Object.keys(propVals));

      return { subject, propVals, datatypeOf: datatypes.resolver };
    },
  };
}
