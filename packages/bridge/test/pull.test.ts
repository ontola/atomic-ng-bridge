import { describe, expect, it, vi } from 'vitest';
import {
  AtomicDatatype,
  aliasResourceTriples,
  bridge as vocab,
  createMemoryCursorStore,
  createPuller,
  createPusher,
  resourceToTriples,
  type AtomicSink,
  type AtomicSnapshot,
  type AtomicSource,
  type NgTransport,
  type Triple,
} from '../src/index.js';

const GRAPH = 'did:ng:o:doc-1';
const SUBJECT = 'did:ad:resource:1';
const P = (name: string) => `https://atomicdata.dev/properties/${name}`;

const datatypes: Record<string, string> = {
  [P('name')]: AtomicDatatype.STRING,
  [P('count')]: AtomicDatatype.INTEGER,
};

const datatypeOf = (property: string) => datatypes[property];

/** A NextGraph document the test can edit directly. */
function fakeGraph(initial: Record<string, Record<string, unknown>> = {}) {
  const documents = new Map<string, Triple[]>();

  // What a push leaves in the document: NextGraph subject, alias record
  // included (alias.ts). A native app's own resource has a `did:ng:` subject
  // already and is stored as is.
  const setSubject = (subject: string, propVals: Record<string, unknown>) => {
    const mapped = resourceToTriples(subject, propVals, { datatypeOf }).triples;
    const stored = aliasResourceTriples(subject, mapped, GRAPH);
    documents.set(stored.subject, stored.triples);
  };

  for (const [subject, propVals] of Object.entries(initial)) {
    setSubject(subject, propVals);
  }

  let notify: (() => void) | undefined;
  let closed = false;

  const transport: NgTransport & {
    queryValues: (sparql: string, variable: string) => Promise<string[]>;
  } = {
    query: async sparql => {
      if (sparql.includes(`?p <${vocab.atomicSubject}> ?o`)) {
        // The alias listing: every origin record, as `?p` (NextGraph subject)
        // and `?o` (Atomic subject) bindings.
        return [...documents.values()].flatMap(triples =>
          triples
            .filter(triple => triple.predicate === vocab.atomicSubject)
            .map(triple => ({
              subject: '',
              predicate: triple.subject,
              object: triple.object,
            })),
        );
      }

      const match = /<([^>]+)> \?p \?o/.exec(sparql);

      return match === null ? [] : (documents.get(match[1]!) ?? []);
    },
    queryValues: async () => [...documents.keys()],
    update: async () => undefined,
    subscribe: async callback => {
      notify = callback;

      return {
        close: () => {
          closed = true;
          notify = undefined;
        },
      };
    },
    close: async () => undefined,
  };

  return {
    transport,
    /** A NextGraph-native app writes to the document. */
    edit: (subject: string, propVals: Record<string, unknown>) => {
      setSubject(subject, propVals);
      notify?.();
    },
    remove: (subject: string) => {
      documents.delete(aliasResourceTriples(subject, [], GRAPH).subject);
      notify?.();
    },
    isClosed: () => closed,
  };
}

function fakeSink() {
  const applied: { subject: string; propVals: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const warmed: string[] = [];

  const sink: AtomicSink = {
    applyResource: async (subject, propVals) => {
      applied.push({ subject, propVals });
    },
    removeResource: async subject => {
      removed.push(subject);
    },
    datatypeOf,
    warmDatatypes: async properties => {
      warmed.push(...properties);
    },
  };

  return { sink, applied, removed, warmed };
}

const setup = (initial?: Record<string, Record<string, unknown>>) => {
  const graph = fakeGraph(initial);
  const sink = fakeSink();
  const cursors = createMemoryCursorStore();
  const puller = createPuller({
    graph: GRAPH,
    sink: sink.sink,
    transport: graph.transport,
    cursors,
  });

  return { ...graph, ...sink, cursors, puller };
};

describe('pulling a NextGraph change', () => {
  it('applies it locally as an ordinary commit', async () => {
    const t = setup({ [SUBJECT]: { [P('name')]: 'from nextgraph' } });

    const result = await t.puller.pullAll();

    expect(result.applied).toEqual([SUBJECT]);
    expect(t.applied[0]!.propVals).toEqual({ [P('name')]: 'from nextgraph' });
  });

  it('loads property datatypes before mapping, so string subtypes survive', async () => {
    const t = setup({ [SUBJECT]: { [P('name')]: 'x', [P('count')]: 3 } });

    await t.puller.pullAll();

    expect(t.warmed.sort()).toEqual([P('count'), P('name')].sort());
    expect(t.applied[0]!.propVals[P('count')]).toBe(3);
  });

  it('does nothing when the local copy already matches', async () => {
    const t = setup({ [SUBJECT]: { [P('name')]: 'same' } });

    await t.puller.pullAll();
    const second = await t.puller.pullAll();

    expect(second.unchanged).toEqual([SUBJECT]);
    expect(t.applied).toHaveLength(1);
  });

  it('keeps going when one subject fails', async () => {
    const t = setup({
      [SUBJECT]: { [P('name')]: 'a' },
      'did:ad:resource:2': { [P('name')]: 'b' },
    });
    let calls = 0;
    t.sink.applyResource = async () => {
      calls++;

      if (calls === 1) {
        throw new Error('local write failed');
      }
    };

    const result = await t.puller.pullAll();

    expect(result.failed).toEqual([SUBJECT]);
    expect(result.applied).toEqual(['did:ad:resource:2']);
    // No cursor for the failed one, so the next pull retries it.
    expect(await t.cursors.get(SUBJECT)).toBeUndefined();
  });
});

describe('removals', () => {
  it('removes a resource that is gone from the document', async () => {
    const t = setup({ [SUBJECT]: { [P('name')]: 'a' } });

    await t.puller.pullAll();
    t.remove(SUBJECT);
    const result = await t.puller.pull([SUBJECT]);

    expect(result.removed).toEqual([SUBJECT]);
    expect(t.removed).toEqual([SUBJECT]);
  });

  it('does not delete a local resource it never mirrored', async () => {
    const t = setup();

    // Someone asks us to pull a subject the document has nothing for, and that
    // we have no cursor for. Deleting the local resource on that basis would be
    // destroying data on the strength of an absence.
    const result = await t.puller.pull(['did:ad:resource:never-mirrored']);

    expect(result.removed).toEqual([]);
    expect(t.removed).toEqual([]);
  });
});

describe('scope', () => {
  it('ignores subjects it was told not to mirror', async () => {
    const graph = fakeGraph({
      [SUBJECT]: { [P('name')]: 'ours' },
      'did:ng:o:someone-elses-subject': { [P('name')]: 'theirs' },
    });
    const sink = fakeSink();
    const puller = createPuller({
      graph: GRAPH,
      sink: sink.sink,
      transport: graph.transport,
      cursors: createMemoryCursorStore(),
      shouldPull: subject => subject !== 'did:ng:o:someone-elses-subject',
    });

    await puller.pullAll();

    expect(sink.applied.map(entry => entry.subject)).toEqual([SUBJECT]);
  });
});

describe('subscription', () => {
  it('pulls when the document changes, and stops when closed', async () => {
    const t = setup();
    const stop = await t.puller.start();

    t.edit(SUBJECT, { [P('name')]: 'pushed by a native app' });
    await vi.waitFor(() => expect(t.applied).toHaveLength(1));

    stop();

    expect(t.isClosed()).toBe(true);
  });

  /**
   * `doc_subscribe` is document-grained, and our own pushes notify us too, so a
   * burst of edits used to mean one full document re-read per edit. On a real
   * drive that saturated the main thread and froze the tab.
   */
  it('collapses a burst of notifications into one read', async () => {
    const graph = fakeGraph({ [SUBJECT]: { [P('name')]: 'a' } });
    const sink = fakeSink();
    let reads = 0;
    const counting = {
      ...graph.transport,
      queryValues: async (...args: [string, string]) => {
        reads++;

        return graph.transport.queryValues(...args);
      },
    };
    const puller = createPuller({
      graph: GRAPH,
      sink: sink.sink,
      transport: counting,
      cursors: createMemoryCursorStore(),
      pullDebounceMs: 20,
    });

    await puller.start();

    for (let i = 0; i < 25; i++) {
      graph.edit(SUBJECT, { [P('name')]: `edit ${i}` });
    }

    await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 80));

    // 25 notifications, nowhere near 25 full reads.
    expect(reads).toBeLessThanOrEqual(3);
  });
});

describe('push and pull together', () => {
  /**
   * The one that matters: two directions sharing one cursor store must not
   * feed each other. If this test ever fails it will not fail quietly in
   * production, it will loop until something falls over.
   */
  it('does not loop: a pulled write is not pushed back', async () => {
    const graphSide = fakeGraph({
      [SUBJECT]: { [P('name')]: 'written in nextgraph' },
    });
    const sink = fakeSink();
    const cursors = createMemoryCursorStore();

    // The local store, fed by whatever pull applies to it.
    const local = new Map<string, Record<string, unknown>>();
    let notifyPush: ((subject: string) => void) | undefined;

    sink.sink.applyResource = async (subject, propVals) => {
      local.set(subject, propVals);
      sink.applied.push({ subject, propVals });
      // Applying locally fires a normal store event, exactly as a user edit
      // would. This is the input the push side sees.
      notifyPush?.(subject);
    };

    const source: AtomicSource = {
      onChanged: callback => {
        notifyPush = callback;

        return () => {
          notifyPush = undefined;
        };
      },
      getSnapshot: async (subject): Promise<AtomicSnapshot | undefined> => {
        const propVals = local.get(subject);

        return propVals === undefined
          ? undefined
          : { subject, propVals, datatypeOf };
      },
    };

    const updates: string[] = [];
    const pushTransport: NgTransport = {
      query: async () => [],
      update: async sparql => {
        updates.push(sparql);
      },
      subscribe: async () => ({ close: () => undefined }),
      close: async () => undefined,
    };

    const pusher = createPusher({
      graph: GRAPH,
      source,
      transport: pushTransport,
      cursors,
      autoFlush: false,
    });
    const puller = createPuller({
      graph: GRAPH,
      sink: sink.sink,
      transport: graphSide.transport,
      cursors,
    });

    pusher.start();
    await puller.pullAll();

    expect(sink.applied).toHaveLength(1);
    expect(pusher.pending).toBe(1); // the local write did queue a push

    const flushed = await pusher.flush();

    expect(flushed.skipped).toEqual([SUBJECT]);
    expect(flushed.pushed).toEqual([]);
    expect(updates).toEqual([]); // nothing written back to NextGraph

    // And the reverse: pulling again sees nothing new either.
    const second = await puller.pullAll();

    expect(second.unchanged).toEqual([SUBJECT]);
  });

  it('still propagates a real local edit made after a pull', async () => {
    const cursors = createMemoryCursorStore();
    const local = new Map<string, Record<string, unknown>>([
      [SUBJECT, { [P('name')]: 'edited by the user' }],
    ]);
    const updates: string[] = [];

    const pusher = createPusher({
      graph: GRAPH,
      source: {
        onChanged: () => () => undefined,
        getSnapshot: async subject => {
          const propVals = local.get(subject);

          return propVals === undefined
            ? undefined
            : { subject, propVals, datatypeOf };
        },
      },
      transport: {
        query: async () => [],
        update: async sparql => {
          updates.push(sparql);
        },
        subscribe: async () => ({ close: () => undefined }),
        close: async () => undefined,
      },
      cursors,
      autoFlush: false,
    });

    // Pretend a pull had applied an older version a moment ago.
    const older = aliasResourceTriples(
      SUBJECT,
      resourceToTriples(SUBJECT, { [P('name')]: 'older' }, { datatypeOf }).triples,
      GRAPH,
    );
    await cursors.set(SUBJECT, {
      hash: (await import('../src/canonical.js')).contentHash(older.triples),
      predicates: [P('name')],
    });

    pusher.notifyChanged(SUBJECT);
    const result = await pusher.flush();

    expect(result.pushed).toEqual([SUBJECT]);
    expect(updates.join('\n')).toContain('edited by the user');
  });
});
