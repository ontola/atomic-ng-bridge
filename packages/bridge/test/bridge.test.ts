import { describe, expect, it } from 'vitest';
import {
  AtomicDatatype,
  aliasResourceTriples,
  bridge as vocab,
  createBridge,
  createMemoryCursorStore,
  resourceToTriples,
  type AtomicSink,
  type AtomicSource,
  type NgTransport,
  type Triple,
} from '../src/index.js';

const GRAPH = 'did:ng:o:doc-1';
const SUBJECT = 'did:ad:resource:1';
const NAME = 'https://atomicdata.dev/properties/name';
const datatypeOf = () => AtomicDatatype.STRING;

/** What the document holds for SUBJECT: NextGraph subject, alias record included. */
const mirrored = (propVals: Record<string, unknown>) =>
  aliasResourceTriples(
    SUBJECT,
    resourceToTriples(SUBJECT, propVals, { datatypeOf }).triples,
    GRAPH,
  );
const NG_SUBJECT = mirrored({}).subject;

/**
 * A NextGraph document and an Atomic store, both in memory, wired to the same
 * bridge. Enough to test ordering and the shape of the loop, not the engine.
 */
function harness(options: {
  ngState?: Record<string, unknown>;
  localState?: Record<string, unknown>;
}) {
  const events: string[] = [];
  const ng = new Map<string, Triple[]>();
  const local = new Map<string, Record<string, unknown>>();
  let notifyLocal: ((subject: string) => void) | undefined;

  if (options.ngState !== undefined) {
    ng.set(NG_SUBJECT, mirrored(options.ngState).triples);
  }

  if (options.localState !== undefined) {
    local.set(SUBJECT, options.localState);
  }

  const transport: NgTransport & {
    queryValues: (sparql: string, variable: string) => Promise<string[]>;
  } = {
    query: async sparql => {
      if (sparql.includes(`?p <${vocab.atomicSubject}> ?o`)) {
        // The alias listing: every origin record, as `?p` (NextGraph subject)
        // and `?o` (Atomic subject) bindings.
        return [...ng.values()].flatMap(triples =>
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

      return match === null ? [] : (ng.get(match[1]!) ?? []);
    },
    queryValues: async () => [...ng.keys()],
    update: async sparql => {
      events.push('ng-write');
      // Good enough for ordering tests: record that NextGraph was written to.
      const value = /"([^"]*)"/.exec(sparql)?.[1];

      if (value !== undefined && sparql.includes('INSERT')) {
        ng.set(NG_SUBJECT, mirrored({ [NAME]: value }).triples);
      }
    },
    subscribe: async () => ({ close: () => undefined }),
    close: async () => {
      events.push('transport-closed');
    },
  };

  const source: AtomicSource = {
    onChanged: callback => {
      notifyLocal = callback;

      return () => {
        notifyLocal = undefined;
      };
    },
    getSnapshot: async subject => {
      const propVals = local.get(subject);

      return propVals === undefined
        ? undefined
        : { subject, propVals, datatypeOf };
    },
  };

  const sink: AtomicSink = {
    datatypeOf,
    applyResource: async (subject, propVals) => {
      events.push('local-write');
      local.set(subject, propVals);
      notifyLocal?.(subject);
    },
    removeResource: async subject => {
      local.delete(subject);
    },
  };

  return {
    events,
    ng,
    local,
    editLocally: (propVals: Record<string, unknown>) => {
      local.set(SUBJECT, propVals);
      notifyLocal?.(SUBJECT);
    },
    bridge: createBridge({
      graph: GRAPH,
      source,
      sink,
      transport,
      cursors: createMemoryCursorStore(),
      push: { debounceMs: 1 },
    }),
  };
}

describe('startup ordering', () => {
  it('pulls before it pushes, so an offline NextGraph edit is not overwritten', async () => {
    // The app was closed; someone edited the resource in NextGraph meanwhile.
    // Locally we still hold the older value.
    const t = harness({
      ngState: { [NAME]: 'edited elsewhere while we were closed' },
      localState: { [NAME]: 'our stale copy' },
    });

    await t.bridge.start();
    await t.bridge.flush();

    // The NextGraph value won, and nothing was written back over it.
    expect(t.local.get(SUBJECT)).toEqual({
      [NAME]: 'edited elsewhere while we were closed',
    });
    expect(t.events.filter(event => event === 'ng-write')).toEqual([]);
    // Pull ran first.
    expect(t.events[0]).toBe('local-write');
  });

  it('reports the initial pull as done once started', async () => {
    const t = harness({ ngState: { [NAME]: 'x' } });

    expect(t.bridge.status.initialPullDone).toBe(false);
    await t.bridge.start();
    expect(t.bridge.status.initialPullDone).toBe(true);
    expect(t.bridge.status.running).toBe(true);
  });
});

describe('the loop, through the bridge object', () => {
  it('pushes a local edit and does not echo it back', async () => {
    const t = harness({ localState: { [NAME]: 'first' } });

    await t.bridge.start();
    t.editLocally({ [NAME]: 'edited by the user' });

    const flushed = await t.bridge.flush();

    expect(flushed.pushed).toEqual([SUBJECT]);

    // Pulling now sees what we just wrote and recognizes it as ours.
    const pulled = await t.bridge.pullAll();

    expect(pulled.unchanged).toEqual([SUBJECT]);
    expect(pulled.applied).toEqual([]);
  });

  it('applies a NextGraph change without pushing it back', async () => {
    const t = harness({ ngState: { [NAME]: 'from nextgraph' } });

    await t.bridge.start();
    t.events.length = 0;

    const flushed = await t.bridge.flush();

    expect(flushed.pushed).toEqual([]);
    expect(t.events.filter(event => event === 'ng-write')).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('closes the transport and stops listening on stop', async () => {
    const t = harness({ localState: { [NAME]: 'x' } });

    await t.bridge.start();
    await t.bridge.stop();

    expect(t.events).toContain('transport-closed');
    expect(t.bridge.status.running).toBe(false);

    // A local edit after stopping queues nothing.
    t.editLocally({ [NAME]: 'ignored' });

    expect(t.bridge.status.pending).toBe(0);
  });

  it('surfaces a push failure in status rather than throwing', async () => {
    let notify: ((subject: string) => void) | undefined;
    const broken = createBridge({
      graph: GRAPH,
      source: {
        onChanged: callback => {
          notify = callback;

          return () => {
            notify = undefined;
          };
        },
        getSnapshot: async subject => ({
          subject,
          propVals: { [NAME]: 'y' },
          datatypeOf,
        }),
      },
      sink: {
        datatypeOf,
        applyResource: async () => undefined,
        removeResource: async () => undefined,
      },
      transport: {
        query: async () => [],
        update: async () => {
          throw new Error('connection lost');
        },
        subscribe: async () => ({ close: () => undefined }),
        close: async () => undefined,
      },
      cursors: createMemoryCursorStore(),
    });

    await broken.start();
    notify?.(SUBJECT);

    const result = await broken.flush();

    // The edit is not lost: it failed, it is reported, and it stays queued for
    // the next flush. A dropped connection must not silently drop a write.
    expect(result.failed).toEqual([SUBJECT]);
    expect(broken.status.pending).toBe(1);
    expect(broken.status.lastError).toMatchObject({
      direction: 'push',
      subject: SUBJECT,
    });
    expect((broken.status.lastError!.error as Error).message).toBe(
      'connection lost',
    );
  });
});
