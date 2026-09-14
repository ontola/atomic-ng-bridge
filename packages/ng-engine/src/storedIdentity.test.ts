import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CLASS,
  PRIVATE_KEY_PREDICATE,
  ensureStoredIdentity,
} from './storedIdentity.js';
import type { NgSession } from './session.js';
import type { NgWasm } from './wasm.js';

const session: NgSession = {
  sessionId: 7,
  walletName: 'https://nextgraph.net',
  userId: 'u',
};

/** Enough of the SDK to hold one identity document. */
function fakeNg(initial?: { nuri: string; key?: string }) {
  let doc = initial?.nuri;
  let key = initial?.key;
  const updates: string[] = [];

  const ng = {
    sparql_query: async (_s: unknown, sparql: string) => {
      if (sparql.includes(PRIVATE_KEY_PREDICATE)) {
        return {
          results: {
            bindings:
              key === undefined ? [] : [{ key: { type: 'literal', value: key } }],
          },
        };
      }

      if (sparql.includes(IDENTITY_CLASS)) {
        return {
          results: {
            bindings: doc === undefined ? [] : [{ doc: { type: 'uri', value: doc } }],
          },
        };
      }

      return { results: { bindings: [] } };
    },
    sparql_update: async (_s: unknown, sparql: string) => {
      updates.push(sparql);
      const match = sparql.match(new RegExp(`<${PRIVATE_KEY_PREDICATE}> "([^"]+)"`));

      if (match) {
        key = match[1];
      }
    },
    doc_create: async () => {
      doc = 'did:ng:o:identity';

      return doc;
    },
  } as unknown as NgWasm;

  return { ng, updates, get key() { return key; } };
}

describe('stored identity', () => {
  it('generates a key once and stores it in the private store', async () => {
    const fake = fakeNg();
    const bytes = new Uint8Array(32).fill(9);

    const first = await ensureStoredIdentity(fake.ng, session, () => bytes);

    expect(first.created).toBe(true);
    expect(first.nuri).toBe('did:ng:o:identity');
    expect(first.privateKey).toBe(
      'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    );
    expect(fake.updates.some(u => u.includes(PRIVATE_KEY_PREDICATE))).toBe(true);

    const again = await ensureStoredIdentity(fake.ng, session, () => {
      throw new Error('must not generate twice');
    });

    expect(again).toEqual({ ...first, created: false });
  });

  it('reads the key another device already stored', async () => {
    const fake = fakeNg({ nuri: 'did:ng:o:elsewhere', key: 'stored-key' });

    const identity = await ensureStoredIdentity(fake.ng, session, () => {
      throw new Error('must not generate');
    });

    expect(identity).toEqual({
      privateKey: 'stored-key',
      nuri: 'did:ng:o:elsewhere',
      created: false,
    });
    expect(fake.updates).toEqual([]);
  });
});
