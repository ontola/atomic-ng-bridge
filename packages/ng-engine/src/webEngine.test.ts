import { describe, expect, it } from 'vitest';
import { createWebEngine, type WebSdk } from './webEngine.js';
import { PRIVATE_KEY_PREDICATE } from './storedIdentity.js';
import type { NgWasm } from './wasm.js';

function stubSdk(): { sdk: WebSdk; calls: string[] } {
  const calls: string[] = [];
  let key: string | undefined;

  const ng = {
    sparql_query: async (_s: unknown, sparql: string) => {
      calls.push(`query:${sparql.slice(0, 40)}`);

      return {
        results: {
          bindings:
            sparql.includes(PRIVATE_KEY_PREDICATE) && key !== undefined
              ? [{ key: { type: 'literal', value: key } }]
              : [],
        },
      };
    },
    sparql_update: async (_s: unknown, sparql: string) => {
      calls.push('update');
      key = sparql.match(/"([^"]+)"/)?.[1];
    },
    doc_create: async () => {
      calls.push('doc_create');

      return 'did:ng:o:doc';
    },
    doc_subscribe: async (_g: string, _s: unknown, cb: () => void) => {
      calls.push('subscribe');
      cb();

      return () => calls.push('closed');
    },
  } as unknown as NgWasm;

  const sdk: WebSdk = {
    ng,
    init: async callback => {
      calls.push('init');
      callback?.({
        status: 'loggedin',
        session: { session_id: 42, private_store_id: 'ps', user: 'user-1' },
      });
    },
  };

  return { sdk, calls };
}

describe('hosted-wallet engine', () => {
  it('takes the session from the wallet page and an identity from its store', async () => {
    const { sdk, calls } = stubSdk();
    const engine = createWebEngine({ sdk: async () => sdk });

    const result = await engine.open({ kind: 'web' });

    expect(engine.mode).toBe('web');
    expect(result.userId).toBe('user-1');
    expect(result.privateStoreId).toBe('ps');
    expect(result.created).toBe(true);
    expect(result.atomicPrivateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls[0]).toBe('init');
    expect(calls).toContain('doc_create');
  });

  it('refuses to open a wallet of its own', async () => {
    const { sdk } = stubSdk();
    const engine = createWebEngine({ sdk: async () => sdk });

    await expect(
      engine.open({ kind: 'saved', password: 'x' }),
    ).rejects.toThrow(/kind: "web"/);
  });

  it('closes a subscription through the function the proxy returns', async () => {
    const { sdk, calls } = stubSdk();
    const engine = createWebEngine({ sdk: async () => sdk });
    await engine.open({ kind: 'web' });

    let fired = 0;
    const subscription = await engine
      .transport('did:ng:o:doc')
      .subscribe(() => fired++);
    subscription.close();

    expect(fired).toBe(1);
    expect(calls.at(-1)).toBe('closed');
  });
});
