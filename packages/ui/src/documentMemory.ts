/**
 * Which NextGraph document a workspace mirrors into.
 *
 * Finding the document by querying for its class triple looked right and is
 * wrong. In a fresh browser session the local store starts empty and the
 * user's repos arrive *after* the broker connection opens
 * (`bootstrap_from_remote`, called from `connection_opened` in
 * `engine/verifier/src/verifier.rs`). A discovery query run before they land
 * returns nothing, so the bridge concluded there was no document and created
 * another one. Observed live: five reloads, five orphan
 * documents, each holding nothing but its own class triple, while the real
 * data sat in a sixth.
 *
 * So the nuri is remembered here instead of rediscovered. It is not a secret
 * and not the data; losing it costs a rediscovery, not a document.
 */

const key = (drive: string): string => `atomic.ngBridge.doc.${drive}`;

/** The document this workspace mirrored into last time, if we know it. */
export function rememberedDocument(drive: string): string | undefined {
  try {
    return localStorage.getItem(key(drive)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Records the document for this workspace, so the next session reopens it. */
export function rememberDocument(drive: string, nuri: string): void {
  try {
    localStorage.setItem(key(drive), nuri);
  } catch {
    // Without storage the workspace rediscovers or recreates next load. The
    // mirror still works; it just cannot be resumed.
  }
}

/** Forgets the document, e.g. when the user stops mirroring for good. */
export function forgetDocument(drive: string): void {
  try {
    localStorage.removeItem(key(drive));
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}
