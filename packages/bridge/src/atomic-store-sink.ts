/**
 * The pull side's landing point in `@tomic/lib`.
 *
 * Writes go through `set()` + `save()`, the same path a user's edit takes, so
 * a pulled change produces an ordinary local commit: history, undo and every
 * live subscriber behave normally, with nothing special-cased for bridged data.
 * We deliberately do not forge commits or write to the store's cache directly.
 *
 * Together with `atomic-store-source.ts` these are the only two files in this
 * package that know `@tomic/lib` exists.
 */

import type { Resource, Store } from '@tomic/lib';
import type { AtomicSink } from './pull.js';
import type { DatatypeResolver } from './types.js';
import { isVolatileProperty } from './vocab.js';

export type AtomicStoreSinkOptions = {
  store: Store;
  /**
   * The local-only drive pulled resources belong under. Resources that do not
   * exist yet are created with this as their parent, so they inherit the
   * drive's local-only status and are never POSTed anywhere.
   */
  drive: string;
  /**
   * Called before a pulled resource is created. Return false to skip it: a
   * NextGraph document can contain subjects that are not ours to materialize.
   */
  shouldCreate?: (subject: string) => boolean;
};

export function createAtomicStoreSink(
  options: AtomicStoreSinkOptions,
): AtomicSink {
  const { store, drive, shouldCreate = () => true } = options;
  const datatypes = new Map<string, string | undefined>();

  const warmDatatypes = async (properties: string[]): Promise<void> => {
    await Promise.all(
      properties
        .filter(property => !datatypes.has(property))
        .map(async property => {
          try {
            const loaded = await store.getProperty(property);
            datatypes.set(
              property,
              loaded.error === undefined ? loaded.datatype : undefined,
            );
          } catch {
            datatypes.set(property, undefined);
          }
        }),
    );
  };

  const datatypeOf: DatatypeResolver = property => datatypes.get(property);

  return {
    datatypeOf,
    warmDatatypes,

    applyResource: async (subject, propVals) => {
      // `getResource` throws for a subject the store cannot fetch (a `did:ng:`
      // subject has no Atomic location to fetch from), rather than returning an
      // errored resource. Treat that as "we do not have it yet".
      let resource: Resource | undefined;

      try {
        resource = await store.getResource(subject);
      } catch {
        resource = undefined;
      }

      if (resource === undefined || !resource.isReady()) {
        if (!shouldCreate(subject)) {
          return;
        }

        // New to us: mint it under the local-only drive so it never leaves the
        // device, keeping the subject NextGraph already uses.
        resource = await store.newResource({ subject, parent: drive });
      }

      // Clear properties the NextGraph side no longer has, or they would
      // linger locally as ghosts of a value someone deleted elsewhere. Commit
      // bookkeeping is exempt: it is the local store's, not the mirror's.
      const incoming = new Set(Object.keys(propVals));

      for (const property of Object.keys(resource.getPropVals())) {
        if (!incoming.has(property) && !isVolatileProperty(property)) {
          resource.removeUnsafe(property);
        }
      }

      for (const [property, value] of Object.entries(propVals)) {
        if (isVolatileProperty(property)) {
          continue;
        }

        // Validation would fetch the Property resource per value; we already
        // warmed the ones we need, and the mapping produced these values from
        // those same datatypes.
        await resource.set(property, value as never, false);
      }

      await resource.save();
    },

    removeResource: async subject => {
      try {
        const resource = await store.getResource(subject);

        if (resource.isReady()) {
          await resource.destroy();
        }
      } catch {
        // Nothing local to remove.
      }
    },
  };
}
