import { describe, expect, it, vi } from 'vitest';
import {
  AtomicDatatype,
  aliasResourceTriples,
  bridge,
  contentHash,
  createMemoryCursorStore,
  createPusher,
  resourceToTriples,
  type AtomicSnapshot,
  type AtomicSource,
  type NgTransport,
  type Triple,
} from '../src/index.js';

const GRAPH = 'did:ng:o:doc-1';
const P = (name: string) => `https://atomicdata.dev/properties/${name}`;

const datatypes: Record<string, string> = {
  [P('name')]: AtomicDatatype.STRING,
  [P('count')]: AtomicDatatype.INTEGER,
  [P('parent')]: AtomicDatatype.ATOMIC_URL,
};

const datatypeOf = (property: string) => datatypes[property];

/** A store of snapshots the test can mutate, plus a change callback. */
function fakeSource(initial: Record<string, Record<string, unknown>> = {}) {
  const resources = new Map(Object.entries(initial));
  let notify: ((subject: string) => void) | undefined;
  let unsubscribed = false;

  const source: AtomicSource = {
    onChanged: callback => {
      notify = callback;

      return () => {
        unsubscribed = true;
        notify = undefined;
      };
    },
    getSnapshot: async (subject): Promise<AtomicSnapshot | undefined> => {
      const propVals = resources.get(subject);

      return propVals === undefined
        ? undefined
        : { subject, propVals, datatypeOf };
    },
  };

  return {
    source,
    edit: (subject: string, propVals: Record<string, unknown>) => {
      resources.set(subject, propVals);
      notify?.(subject);
    },
    remove: (subject: string) => {
      resources.delete(subject);
      notify?.(subject);
    },
    isUnsubscribed: () => unsubscribed,
  };
}

/** Records every update, and can be told to fail the next N of them. */
function fakeTransport() {
  const updates: string[] = [];
  let failures = 0;

  const transport: NgTransport = {
    update: async sparql => {
      if (failures > 0) {
        failures--;
        throw new Error('engine unreachable');
      }

      updates.push(sparql);
    },
    query: async (): Promise<Triple[]> => [],
    subscribe: async () => ({ close: () => undefined }),
    close: async () => undefined,
  };

  return {
    transport,
    updates,
    failNext: (count: number) => {
      failures = count;
    },
  };
}

const setup = (initial?: Record<string, Record<string, unknown>>) => {
  const source = fakeSource(initial);
  const transport = fakeTransport();
  const cursors = createMemoryCursorStore();
  const pusher = createPusher({
    graph: GRAPH,
    source: source.source,
    transport: transport.transport,
    cursors,
    // The engine accepts `;`-separated updates (NEXTGRAPH-ISSUES.md C2), but
    // most of these tests read the delete and the insert separately, so they
    // opt into the two-step path explicitly.
    supportsMultiOperationUpdate: false,
    autoFlush: false,
  });

  return { ...source, ...transport, cursors, pusher };
};

describe('pushing a changed resource', () => {
  it('writes a subject-scoped replace and records the cursor', async () => {
    const t = setup();
    const stop = t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'Buy milk' });
    const result = await t.pusher.flush();

    expect(result.pushed).toEqual(['did:ad:resource:1']);
    expect(t.updates).toHaveLength(2); // delete, then insert
    expect(t.updates[0]).toContain('DELETE');
    expect(t.updates[1]).toContain('Buy milk');
    expect(t.updates[1]).toContain(`GRAPH <${GRAPH}>`);
    expect(await t.cursors.get('did:ad:resource:1')).toBeDefined();

    stop();
  });

  it('sends one update instead of two by default, as the engine accepts multi-op', async () => {
    const source = fakeSource();
    const transport = fakeTransport();
    const pusher = createPusher({
      graph: GRAPH,
      source: source.source,
      transport: transport.transport,
      cursors: createMemoryCursorStore(),
      autoFlush: false,
    });

    pusher.start();
    source.edit('did:ad:resource:1', { [P('name')]: 'x' });
    await pusher.flush();

    expect(transport.updates).toHaveLength(1);
    expect(transport.updates[0]).toContain('DELETE');
    expect(transport.updates[0]).toContain('INSERT DATA');
  });

  it('collapses repeated edits to one subject into a single push', async () => {
    const t = setup();
    t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'a' });
    t.edit('did:ad:resource:1', { [P('name')]: 'b' });
    t.edit('did:ad:resource:1', { [P('name')]: 'c' });

    expect(t.pusher.pending).toBe(1);

    const result = await t.pusher.flush();

    expect(result.pushed).toEqual(['did:ad:resource:1']);
    expect(t.updates[1]).toContain('"c"');
    expect(t.updates[1]).not.toContain('"a"');
  });

  it('deletes the subject from the graph when it is removed locally', async () => {
    const t = setup({ 'did:ad:resource:1': { [P('name')]: 'a' } });
    t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'a' });
    await t.pusher.flush();
    t.updates.length = 0;

    t.remove('did:ad:resource:1');
    const result = await t.pusher.flush();

    expect(result.deleted).toEqual(['did:ad:resource:1']);
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]).toContain('DELETE');
    // Scoped to what we wrote, so a native app's own predicates survive. The
    // alias record (alias.ts) is ours too, and goes with the resource.
    expect(t.updates[0]).toContain(
      `VALUES ?p { <${bridge.atomicSubject}> <${P('name')}> }`,
    );
    // The cursor goes too, so re-creating the resource is seen as a change.
    expect(await t.cursors.get('did:ad:resource:1')).toBeUndefined();
  });

  it('surfaces mapping warnings instead of swallowing them', async () => {
    const source = fakeSource();
    const transport = fakeTransport();
    const onWarning = vi.fn();
    const pusher = createPusher({
      graph: GRAPH,
      source: source.source,
      transport: transport.transport,
      cursors: createMemoryCursorStore(),
      autoFlush: false,
      onWarning,
    });

    pusher.start();
    source.edit('did:ad:resource:1', { [P('parent')]: { inline: true } });
    await pusher.flush();

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toMatchObject({
      kind: 'lossy-nested-resource',
    });
  });
});

describe('idempotence and resume', () => {
  it('skips a subject NextGraph already has, byte for byte', async () => {
    const t = setup();
    t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'same' });
    await t.pusher.flush();
    t.updates.length = 0;

    // A save that did not actually change any property value still fires an
    // event. It must not cost a commit.
    t.edit('did:ad:resource:1', { [P('name')]: 'same' });
    const result = await t.pusher.flush();

    expect(result.skipped).toEqual(['did:ad:resource:1']);
    expect(t.updates).toHaveLength(0);
  });

  it('re-pushes rather than skips when the cursor was lost', async () => {
    const source = fakeSource({ 'did:ad:resource:1': { [P('name')]: 'a' } });
    const transport = fakeTransport();
    // A fresh cursor store stands in for a cleared IndexedDB.
    const pusher = createPusher({
      graph: GRAPH,
      source: source.source,
      transport: transport.transport,
      cursors: createMemoryCursorStore(),
      autoFlush: false,
    });

    pusher.notifyChanged('did:ad:resource:1');
    const result = await pusher.flush();

    expect(result.pushed).toEqual(['did:ad:resource:1']);
  });

  it('resumes a push interrupted mid-write without duplicating or skipping', async () => {
    const t = setup();
    t.pusher.start();

    // The delete lands, then the process dies before the insert.
    t.failNext(0);
    t.edit('did:ad:resource:1', { [P('name')]: 'a' });
    const transportFail = t;
    transportFail.failNext(1);
    // First update (DELETE) throws; nothing is recorded.
    const first = await t.pusher.flush();

    expect(first.failed).toEqual(['did:ad:resource:1']);
    expect(await t.cursors.get('did:ad:resource:1')).toBeUndefined();
    // Still queued, so the next flush retries it.
    expect(t.pusher.pending).toBe(1);

    const second = await t.pusher.flush();

    expect(second.pushed).toEqual(['did:ad:resource:1']);
    expect(t.updates.filter(u => u.includes('INSERT DATA'))).toHaveLength(1);
  });

  it('keeps other subjects moving when one fails', async () => {
    const t = setup();
    t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'a' });
    t.edit('did:ad:resource:2', { [P('name')]: 'b' });
    t.failNext(1); // only the first subject's DELETE fails

    const result = await t.pusher.flush();

    expect(result.failed).toEqual(['did:ad:resource:1']);
    expect(result.pushed).toEqual(['did:ad:resource:2']);
  });
});

describe('echo suppression', () => {
  it('does not push a write that came from NextGraph', async () => {
    const t = setup();
    t.pusher.start();

    // What the pull side would do: apply NextGraph's state locally, then record
    // the hash of exactly what it applied.
    const propVals = { [P('name')]: 'from nextgraph' };
    const { triples } = aliasResourceTriples(
      'did:ad:resource:1',
      resourceToTriples('did:ad:resource:1', propVals, { datatypeOf }).triples,
      GRAPH,
    );
    await t.cursors.set('did:ad:resource:1', {
      hash: contentHash(triples),
      predicates: [...new Set(triples.map(t2 => t2.predicate))],
    });

    // The local write that pull just made fires a change event like any other.
    t.edit('did:ad:resource:1', propVals);
    const result = await t.pusher.flush();

    expect(result.skipped).toEqual(['did:ad:resource:1']);
    expect(t.updates).toHaveLength(0);
  });

  it('still pushes when the user edits on top of a pulled write', async () => {
    const t = setup();
    t.pusher.start();

    const pulled = { [P('name')]: 'from nextgraph' };
    const { triples } = aliasResourceTriples(
      'did:ad:resource:1',
      resourceToTriples('did:ad:resource:1', pulled, { datatypeOf }).triples,
      GRAPH,
    );
    await t.cursors.set('did:ad:resource:1', {
      hash: contentHash(triples),
      predicates: [...new Set(triples.map(t2 => t2.predicate))],
    });

    t.edit('did:ad:resource:1', { [P('name')]: 'edited locally' });
    const result = await t.pusher.flush();

    expect(result.pushed).toEqual(['did:ad:resource:1']);
  });

  it('hashes independently of property order, so a reordered read is not a change', async () => {
    const a = resourceToTriples('s', { [P('name')]: 'x', [P('count')]: 1 }, { datatypeOf });
    const b = resourceToTriples('s', { [P('count')]: 1, [P('name')]: 'x' }, { datatypeOf });

    expect(contentHash(a.triples)).toBe(contentHash(b.triples));
  });
});

describe('lifecycle', () => {
  it('chains overlapping flushes instead of interleaving them', async () => {
    const order: string[] = [];
    const source = fakeSource();
    const transport: NgTransport = {
      update: async sparql => {
        order.push(sparql.includes('DELETE') ? 'delete' : 'insert');
        await new Promise(resolve => setTimeout(resolve, 1));
      },
      query: async () => [],
      subscribe: async () => ({ close: () => undefined }),
      close: async () => undefined,
    };
    const pusher = createPusher({
      graph: GRAPH,
      source: source.source,
      transport,
      cursors: createMemoryCursorStore(),
      // Two-step on purpose: interleaving is only observable when a replace has
      // two halves that could be interleaved.
      supportsMultiOperationUpdate: false,
      autoFlush: false,
    });

    pusher.start();
    source.edit('did:ad:resource:1', { [P('name')]: 'a' });
    const first = pusher.flush();
    source.edit('did:ad:resource:2', { [P('name')]: 'b' });
    const second = pusher.flush();
    await Promise.all([first, second]);

    // Two complete replaces, never a delete/delete/insert/insert interleave.
    expect(order).toEqual(['delete', 'insert', 'delete', 'insert']);
  });

  it('auto-flushes after the debounce window', async () => {
    const source = fakeSource();
    const transport = fakeTransport();
    const pusher = createPusher({
      graph: GRAPH,
      source: source.source,
      transport: transport.transport,
      cursors: createMemoryCursorStore(),
      debounceMs: 5,
    });

    pusher.start();
    source.edit('did:ad:resource:1', { [P('name')]: 'a' });

    // One update, because a replace is a single `;`-separated statement now.
    await vi.waitFor(() => expect(transport.updates.length).toBe(1));
  });

  it('stops listening and cancels a pending flush', async () => {
    const t = setup();
    const stop = t.pusher.start();

    stop();
    t.edit('did:ad:resource:1', { [P('name')]: 'a' });

    expect(t.isUnsubscribed()).toBe(true);
    expect(t.pusher.pending).toBe(0);
  });
});

describe('not destroying data the bridge did not write', () => {
  it('deletes only its own predicates, so native NextGraph properties survive', async () => {
    const t = setup();
    t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'a' });
    await t.pusher.flush();
    t.updates.length = 0;

    t.edit('did:ad:resource:1', { [P('name')]: 'b' });
    await t.pusher.flush();

    const del = t.updates[0]!;

    expect(del).toContain('VALUES ?p {');
    expect(del).toContain(P('name'));
    // A NextGraph-native app that added its own predicate to this subject is
    // untouched: the delete never names a wildcard predicate.
    expect(del).not.toMatch(/WHERE \{ GRAPH <[^>]+> \{ <[^>]+> \?p \?o \} \}$/);
  });

  it('still clears a property the user removed', async () => {
    const t = setup();
    t.pusher.start();

    t.edit('did:ad:resource:1', { [P('name')]: 'a', [P('count')]: 1 });
    await t.pusher.flush();
    t.updates.length = 0;

    t.edit('did:ad:resource:1', { [P('name')]: 'a' });
    await t.pusher.flush();

    // `count` is gone from the resource, so it has to be named in the delete
    // even though it is not in the insert.
    expect(t.updates[0]).toContain(P('count'));
    expect(t.updates[1]).not.toContain(P('count'));
  });

  it('writes nothing on a delete it has no record of writing', async () => {
    const t = setup();
    t.pusher.start();

    // No cursor: either never mirrored, or the cursor store was cleared. Either
    // way the bridge has no basis for removing anything from the graph.
    t.pusher.notifyChanged('did:ad:resource:unknown');
    const result = await t.pusher.flush();

    expect(result.deleted).toEqual(['did:ad:resource:unknown']);
    expect(t.updates).toHaveLength(0);
  });

  it('takes the whole subject when preserveForeignPredicates is off', async () => {
    const source = fakeSource({ 'did:ad:resource:1': { [P('name')]: 'a' } });
    const transport = fakeTransport();
    const pusher = createPusher({
      graph: GRAPH,
      source: source.source,
      transport: transport.transport,
      cursors: createMemoryCursorStore(),
      preserveForeignPredicates: false,
      autoFlush: false,
    });

    pusher.notifyChanged('did:ad:resource:1');
    await pusher.flush();

    expect(transport.updates[0]).not.toContain('VALUES');
  });
});
