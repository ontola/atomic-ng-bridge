/**
 * Per-predicate three-way merge, in the document's own terms.
 *
 * The bridge keeps, per subject, the triples it last knew the document to
 * hold (`CursorEntry.triples`). That is the base. Against it, a change on
 * either side is visible per predicate: a predicate whose triples differ from
 * the base has changed. Merging then needs no timestamps and no CRDT on the
 * bridge's side:
 *
 * - push writes only the predicates that changed locally, so a predicate a
 *   native app changed meanwhile is not overwritten with a stale value;
 * - pull applies only the predicates that changed remotely, so a field the
 *   user just edited is not overwritten with a stale value.
 *
 * The one case this cannot resolve is the same predicate changed on both
 * sides inside one window. Then whichever direction runs first wins that
 * predicate, both sides converge on it, and the loser is reported as a
 * `concurrent-edit` warning (its value is still in the Atomic-side history).
 */

import { serializeTerm } from './sparql.js';
import type { Triple } from './types.js';

/** predicate -> the subject's objects for it, canonical and sorted. */
export function objectsByPredicate(
  triples: Triple[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const triple of triples) {
    const list = map.get(triple.predicate) ?? [];
    list.push(serializeTerm(triple.object));
    map.set(triple.predicate, list);
  }

  for (const list of map.values()) {
    list.sort();
  }

  return map;
}

const same = (a: string[] | undefined, b: string[] | undefined): boolean =>
  a === undefined
    ? b === undefined
    : b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Predicates whose triples differ between `current` and `base`, including
 * predicates present on only one side.
 */
export function changedPredicates(current: Triple[], base: Triple[]): string[] {
  const now = objectsByPredicate(current);
  const then = objectsByPredicate(base);
  const changed: string[] = [];

  for (const predicate of new Set([...now.keys(), ...then.keys()])) {
    if (!same(now.get(predicate), then.get(predicate))) {
      changed.push(predicate);
    }
  }

  return changed.sort();
}

export type MergeResult = {
  triples: Triple[];
  /** Predicates changed on both sides to different values; `remote` won. */
  conflicts: string[];
};

/**
 * Three-way merge with `remote` preferred: a predicate changed remotely takes
 * the remote value; anything else keeps the local value. Used by pull, where
 * the remote side is what the bridge is applying.
 */
export function mergeTriples(
  base: Triple[],
  local: Triple[],
  remote: Triple[],
): MergeResult {
  const baseMap = objectsByPredicate(base);
  const localMap = objectsByPredicate(local);
  const remoteMap = objectsByPredicate(remote);
  const conflicts: string[] = [];
  const triples: Triple[] = [];

  for (const predicate of new Set([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ])) {
    const remoteChanged = !same(remoteMap.get(predicate), baseMap.get(predicate));
    const localChanged = !same(localMap.get(predicate), baseMap.get(predicate));

    if (remoteChanged) {
      if (localChanged && !same(localMap.get(predicate), remoteMap.get(predicate))) {
        conflicts.push(predicate);
      }

      triples.push(...remote.filter(t => t.predicate === predicate));
    } else {
      triples.push(...local.filter(t => t.predicate === predicate));
    }
  }

  return { triples, conflicts: conflicts.sort() };
}
