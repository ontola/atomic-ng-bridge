/**
 * Which workspaces mirror into NextGraph. One choice per workspace.
 *
 * This replaces an earlier rule that only device-local workspaces could be
 * mirrored at all. That rule confused two different things. Atomic is already
 * multi-writer: a change pulled from NextGraph becomes an ordinary local
 * commit, and if the workspace also syncs to a server, it travels there like
 * any other commit. NextGraph is another sync target, not a competing owner,
 * so there is no technical reason to refuse a server-backed workspace.
 *
 * What is real, and what this file exists for, is **consent**. Mirroring a
 * device-local workspace publishes your own data into your own NextGraph
 * document. Mirroring a workspace held on an organisation's server copies that
 * organisation's data somewhere its administrator may know nothing about. That
 * is a decision for a person, not a default, so a workspace mirrors when its
 * owner says so.
 *
 * The default follows the same reasoning: device-local workspaces mirror
 * (nobody else is involved), everything else waits to be asked.
 */

import type { Store } from '@tomic/lib';

const KEY = 'atomic.ngBridge.mirroredDrives';

type Choices = Record<string, boolean>;

function read(): Choices {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Choices;
  } catch {
    return {};
  }
}

function write(choices: Choices): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choices));
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
}

/** What a workspace does when nobody has chosen: see the file comment. */
export function mirrorsByDefault(store: Store, drive: string): boolean {
  return store.isLocalOnlySubject(drive);
}

/** Whether this workspace mirrors, honouring an explicit choice over the default. */
export function isMirrored(store: Store, drive: string): boolean {
  return read()[drive] ?? mirrorsByDefault(store, drive);
}

/** Records the choice for one workspace. */
export function setMirrored(drive: string, mirrored: boolean): void {
  write({ ...read(), [drive]: mirrored });
}

/** Forgets the choice, so the workspace follows the default again. */
export function clearMirrorChoice(drive: string): void {
  const choices = read();
  delete choices[drive];
  write(choices);
}

/**
 * Whether mirroring this workspace would copy someone else's data outward.
 *
 * True for a workspace that lives on a server: the data has a home already, and
 * sending it to NextGraph is a disclosure, not a backup. The UI asks first in
 * that case, and says what it is asking.
 */
export const leavesItsHome = (store: Store, drive: string): boolean =>
  !store.isLocalOnlySubject(drive);
