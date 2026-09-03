import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearMirrorChoice,
  isMirrored,
  leavesItsHome,
  mirrorsByDefault,
  setMirrored,
} from '../src/mirrorPreference.js';

/**
 * The policy, not the plumbing. Getting the default wrong in either direction
 * is a real problem: mirror a server workspace by accident and you have
 * disclosed an organisation's data; refuse a device-local one and the feature
 * looks broken on the only workspace most people have.
 */
// A storage of our own rather than a DOM environment: the module reads
// `localStorage` lazily and tolerates its absence, so a Map is a truer stand-in
// than jsdom and keeps this suite running in plain node.
const store_ = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: key => store_.get(key) ?? null,
  setItem: (key, value) => void store_.set(key, String(value)),
  removeItem: key => void store_.delete(key),
  clear: () => store_.clear(),
  key: index => [...store_.keys()][index] ?? null,
  get length() {
    return store_.size;
  },
} as Storage;

const storeWith = (localOnly: string[]) =>
  ({ isLocalOnlySubject: (s: string) => localOnly.includes(s) }) as never;

const LOCAL = 'did:ad:local-drive';
const SERVER = 'https://example.com/drive';

describe('which workspaces mirror', () => {
  beforeEach(() => localStorage.clear());

  it('mirrors a device-local workspace by default: nobody else is involved', () => {
    const store = storeWith([LOCAL]);

    expect(mirrorsByDefault(store, LOCAL)).toBe(true);
    expect(isMirrored(store, LOCAL)).toBe(true);
  });

  it('waits to be asked for a workspace held on a server', () => {
    const store = storeWith([LOCAL]);

    expect(mirrorsByDefault(store, SERVER)).toBe(false);
    expect(isMirrored(store, SERVER)).toBe(false);
  });

  it('lets an explicit choice win in both directions', () => {
    const store = storeWith([LOCAL]);

    setMirrored(SERVER, true);
    setMirrored(LOCAL, false);

    expect(isMirrored(store, SERVER)).toBe(true);
    expect(isMirrored(store, LOCAL)).toBe(false);
  });

  it('returns to the default when the choice is cleared', () => {
    const store = storeWith([LOCAL]);

    setMirrored(LOCAL, false);
    clearMirrorChoice(LOCAL);

    expect(isMirrored(store, LOCAL)).toBe(true);
  });

  it('keeps each workspace separate', () => {
    const store = storeWith([LOCAL, 'did:ad:other']);

    setMirrored(LOCAL, false);

    expect(isMirrored(store, 'did:ad:other')).toBe(true);
  });

  it('flags a server workspace as leaving its home, and a local one as not', () => {
    const store = storeWith([LOCAL]);

    expect(leavesItsHome(store, SERVER)).toBe(true);
    expect(leavesItsHome(store, LOCAL)).toBe(false);
  });
});
