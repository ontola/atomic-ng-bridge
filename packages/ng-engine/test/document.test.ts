import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_PREDICATE, findOrCreateDocument, waitForDocument } from '../src/index.js';

const SESSION = { sessionId: 's', userId: 'u' } as never;
const CLASS = 'did:ng:z:AtomicDriveMirror';
const KNOWN = 'did:ng:o:known';

const repoNotFound = () => Promise.reject(new Error('RepoNotFound'));
const empty = () => Promise.resolve({ results: { bindings: [] } });

/**
 * The failure these guard against, observed live: a reload asked for its
 * document before the broker had sent it, read the empty answer as "no
 * document exists", and created a second one beside the real data.
 */
describe('opening the document a workspace already mirrors into', () => {
  it('waits for a remembered document rather than creating a rival', async () => {
    let attempts = 0;
    const ng = {
      sparql_query: vi.fn(() => {
        attempts += 1;

        return attempts < 3 ? repoNotFound() : Promise.resolve({});
      }),
      doc_create: vi.fn(),
      sparql_update: vi.fn(),
    } as never;

    const document = await findOrCreateDocument(ng, SESSION, CLASS, {
      knownNuri: KNOWN,
      waitDelayMs: 0,
    });

    expect(document).toEqual({ nuri: KNOWN, created: false });
    expect((ng as { doc_create: ReturnType<typeof vi.fn> }).doc_create).not.toHaveBeenCalled();
  });

  it('falls back to discovery when the remembered document never arrives', async () => {
    const ng = {
      sparql_query: vi.fn((_s: unknown, sparql: string, _b: unknown, nuri?: string) =>
        nuri === KNOWN
          ? repoNotFound()
          : Promise.resolve({
              results: {
                bindings: [{ doc: { type: 'uri', value: 'did:ng:o:found' } }],
              },
            }),
      ),
      doc_create: vi.fn(),
      sparql_update: vi.fn(),
    } as never;

    const document = await findOrCreateDocument(ng, SESSION, CLASS, {
      knownNuri: KNOWN,
      waitAttempts: 2,
      waitDelayMs: 0,
    });

    expect(document).toEqual({ nuri: 'did:ng:o:found', created: false });
  });

  it('creates one only when there is nothing remembered and nothing found', async () => {
    const ng = {
      sparql_query: vi.fn(empty),
      doc_create: vi.fn(() => Promise.resolve('did:ng:o:new')),
      sparql_update: vi.fn(() => Promise.resolve(undefined)),
    } as never;

    expect(await findOrCreateDocument(ng, SESSION, CLASS)).toEqual({
      nuri: 'did:ng:o:new',
      created: true,
    });
  });

  it('reports honestly when no broker holds the document', async () => {
    const ng = { sparql_query: vi.fn(repoNotFound) } as never;

    expect(await waitForDocument(ng, SESSION, KNOWN, 2, 0)).toBe(false);
  });

  it('does not swallow errors that are not a missing repo', async () => {
    const ng = {
      sparql_query: vi.fn(() => Promise.reject(new Error('SyntaxError'))),
    } as never;

    await expect(waitForDocument(ng, SESSION, KNOWN, 1, 0)).rejects.toThrow(
      'SyntaxError',
    );
  });
});

describe('one document per workspace', () => {
  /** A fake store: documents with their class and, optionally, their workspace. */
  const store = (docs: Record<string, string | undefined>) => {
    const updates: string[] = [];
    const ng = {
      sparql_query: vi.fn((_s: unknown, sparql: string) => {
        const byWorkspace = /<([^>]+)> \} \}$/.exec(sparql);
        let hits: string[];

        if (sparql.includes('FILTER NOT EXISTS')) {
          hits = Object.entries(docs).filter(([, ws]) => ws === undefined).map(([d]) => d);
        } else if (sparql.includes(WORKSPACE_PREDICATE) && byWorkspace !== null) {
          hits = Object.entries(docs).filter(([, ws]) => ws === byWorkspace[1]).map(([d]) => d);
        } else {
          hits = Object.keys(docs);
        }

        return Promise.resolve({
          results: { bindings: hits.map(d => ({ doc: { type: 'uri', value: d } })) },
        });
      }),
      doc_create: vi.fn(() => Promise.resolve('did:ng:o:new')),
      sparql_update: vi.fn((_s: unknown, sparql: string) => {
        updates.push(sparql);

        return Promise.resolve(undefined);
      }),
    };

    return { ng: ng as never, updates };
  };

  it('finds the document marked with this workspace, not another workspace\'s', async () => {
    const t = store({ 'did:ng:o:a': 'did:ad:drive-a', 'did:ng:o:b': 'did:ad:drive-b' });

    expect(await findOrCreateDocument(t.ng, SESSION, CLASS, { workspace: 'did:ad:drive-b' })).toEqual({
      nuri: 'did:ng:o:b',
      created: false,
    });
  });

  it('creates a second document for a second workspace in the same wallet', async () => {
    const t = store({ 'did:ng:o:a': 'did:ad:drive-a' });

    const doc = await findOrCreateDocument(t.ng, SESSION, CLASS, { workspace: 'did:ad:drive-b' });

    expect(doc).toEqual({ nuri: 'did:ng:o:new', created: true });
    expect(t.updates.some(u => u.includes(WORKSPACE_PREDICATE) && u.includes('did:ad:drive-b'))).toBe(true);
  });

  it('claims a single document from before workspaces were marked', async () => {
    const t = store({ 'did:ng:o:old': undefined });

    const doc = await findOrCreateDocument(t.ng, SESSION, CLASS, { workspace: 'did:ad:drive-a' });

    expect(doc).toEqual({ nuri: 'did:ng:o:old', created: false });
    expect(t.updates.some(u => u.includes('did:ng:o:old') && u.includes('did:ad:drive-a'))).toBe(true);
  });

  it('does not guess between several unmarked documents', async () => {
    const t = store({ 'did:ng:o:old1': undefined, 'did:ng:o:old2': undefined });

    const doc = await findOrCreateDocument(t.ng, SESSION, CLASS, { workspace: 'did:ad:drive-a' });

    expect(doc.created).toBe(true);
  });
});
