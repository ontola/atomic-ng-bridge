/**
 * Concurrency scenarios: what happens when both sides change inside one sync
 * window. These run the real pusher and puller against a fake NextGraph
 * document that executes the bridge's own SPARQL, and a fake local store that
 * fires change events the way `@tomic/lib` does. Nothing is mocked in between.
 *
 * Each scenario states the outcome it asserts. Where a write is lost, the test
 * says so in its name rather than papering over it: these are the cases a
 * partner will ask about, and the answer has to be what the code does.
 */

import { describe, expect, it } from 'vitest';
import {
  AtomicDatatype,
  createMemoryCursorStore,
  createPuller,
  createPusher,
  ngSubjectFor,
  type AtomicSink,
  type AtomicSnapshot,
  type AtomicSource,
  type NgTransport,
  type Term,
  type Triple,
} from '../src/index.js';

const GRAPH = 'did:ng:o:doc-1';
const ROW = 'did:ad:row-1';
const ROW2 = 'did:ad:row-2';
const P = (name: string) => `https://atomicdata.dev/properties/${name}`;
const NAME = P('name');
const AUTHOR = P('author');
const NOTE = 'https://example.org/native/note';

const datatypes: Record<string, string> = {
  [NAME]: AtomicDatatype.STRING,
  [AUTHOR]: AtomicDatatype.STRING,
};
const datatypeOf = (property: string) => datatypes[property];

// --- A NextGraph document that runs the bridge's own updates -----------------

function parseTerm(text: string): Term {
  if (text.startsWith('<')) {
    return { termType: 'iri', value: text.slice(1, -1) };
  }

  const match = /^"((?:[^"\\]|\\.)*)"(?:\^\^<([^>]+)>|@([a-z-]+))?$/i.exec(text);

  if (match === null) {
    throw new Error(`cannot parse term ${text}`);
  }

  const value = match[1]!.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

  return {
    termType: 'literal',
    value,
    datatype: match[2],
    language: match[3],
  };
}

function fakeDocument() {
  // subject -> triples
  const doc = new Map<string, Triple[]>();
  const log: string[] = [];
  let notify: (() => void) | undefined;
  let offline = false;

  const triplesOf = (subject: string) => doc.get(subject) ?? [];

  const setTriples = (subject: string, triples: Triple[]) => {
    if (triples.length === 0) {
      doc.delete(subject);
    } else {
      doc.set(subject, triples);
    }
  };

  const applyUpdate = (sparql: string) => {
    for (const op of sparql.split(/;\n(?=DELETE|INSERT)/)) {
      if (op.startsWith('DELETE')) {
        const subject = /\{ <([^>]+)> \?p \?o \}/.exec(op)![1]!;
        const values = /VALUES \?p \{ ([^}]*) \}/.exec(op);
        const predicates =
          values === null
            ? undefined
            : values[1]!.trim().split(/\s+/).map(p => p.slice(1, -1));
        setTriples(
          subject,
          triplesOf(subject).filter(
            t => predicates !== undefined && !predicates.includes(t.predicate),
          ),
        );
      } else if (op.startsWith('INSERT')) {
        const lines = op
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('<') && l.endsWith(' .'));

        for (const line of lines) {
          const m = /^<([^>]+)> <([^>]+)> (.+) \.$/.exec(line)!;
          const subject = m[1]!;
          setTriples(subject, [
            ...triplesOf(subject),
            { subject, predicate: m[2]!, object: parseTerm(m[3]!) },
          ]);
        }
      }
    }
  };

  const transport: NgTransport & {
    queryValues: (sparql: string, variable: string) => Promise<string[]>;
  } = {
    query: async sparql => {
      if (sparql.includes('ng-bridge/atomicSubject> ?o')) {
        return [...doc.values()].flatMap(triples =>
          triples
            .filter(t => t.predicate.endsWith('ng-bridge/atomicSubject'))
            .map(t => ({ subject: '', predicate: t.subject, object: t.object })),
        );
      }

      const match = /<([^>]+)> \?p \?o/.exec(sparql);

      return match === null ? [] : triplesOf(match[1]!);
    },
    queryValues: async () => [...doc.keys()],
    update: async sparql => {
      if (offline) {
        throw new Error('broker unreachable');
      }

      log.push(sparql);
      applyUpdate(sparql);
      notify?.();
    },
    subscribe: async callback => {
      notify = callback;

      return { close: () => undefined };
    },
    close: async () => undefined,
  };

  /** A NextGraph-native app sets one predicate on a subject. */
  const nativeSet = (subject: string, predicate: string, value: string) => {
    const ng = ngSubjectFor(subject, GRAPH);
    setTriples(ng, [
      ...triplesOf(ng).filter(t => t.predicate !== predicate),
      { subject: ng, predicate, object: { termType: 'literal', value } },
    ]);
    notify?.();
  };

  const nativeDelete = (subject: string) => {
    doc.delete(ngSubjectFor(subject, GRAPH));
    notify?.();
  };

  const valueOf = (subject: string, predicate: string) =>
    triplesOf(ngSubjectFor(subject, GRAPH)).find(t => t.predicate === predicate)
      ?.object.value;

  return {
    transport,
    log,
    nativeSet,
    nativeDelete,
    valueOf,
    setOffline: (value: boolean) => {
      offline = value;
    },
  };
}

// --- A local store that behaves like @tomic/lib for our purposes -------------

function fakeLocal(initial: Record<string, Record<string, unknown>> = {}) {
  const resources = new Map(Object.entries(initial));
  const history: { subject: string; propVals: Record<string, unknown> }[] = [];
  let notify: ((subject: string) => void) | undefined;

  const source: AtomicSource = {
    onChanged: callback => {
      notify = callback;

      return () => {
        notify = undefined;
      };
    },
    getSnapshot: async (subject): Promise<AtomicSnapshot | undefined> => {
      const propVals = resources.get(subject);

      return propVals === undefined ? undefined : { subject, propVals, datatypeOf };
    },
  };

  const sink: AtomicSink = {
    datatypeOf,
    applyResource: async (subject, propVals) => {
      resources.set(subject, propVals);
      history.push({ subject, propVals });
      notify?.(subject); // a local save fires a change event, like any edit
    },
    removeResource: async subject => {
      resources.delete(subject);
      notify?.(subject);
    },
    currentPropVals: async subject => resources.get(subject),
  };

  return {
    source,
    sink,
    history,
    /** The user edits one property. */
    userSet: (subject: string, property: string, value: unknown) => {
      resources.set(subject, { ...(resources.get(subject) ?? {}), [property]: value });
      notify?.(subject);
    },
    valueOf: (subject: string, property: string) =>
      resources.get(subject)?.[property],
    has: (subject: string) => resources.has(subject),
  };
}

function wire(initial: Record<string, Record<string, unknown>>) {
  const ng = fakeDocument();
  const local = fakeLocal(initial);
  const cursors = createMemoryCursorStore();

  const pusher = createPusher({
    graph: GRAPH,
    source: local.source,
    transport: ng.transport,
    cursors,
    supportsMultiOperationUpdate: false,
    autoFlush: false,
  });
  const puller = createPuller({
    graph: GRAPH,
    sink: local.sink,
    transport: ng.transport,
    cursors,
    pullDebounceMs: 0,
  });

  // The app queues every existing resource when the mirror starts; do the same.
  for (const subject of Object.keys(initial)) {
    pusher.notifyChanged(subject);
  }

  return { ng, local, cursors, pusher, puller };
}

/** Everything the user has, mirrored, and both sides quiet. */
async function settle(t: ReturnType<typeof wire>) {
  for (let i = 0; i < 4; i++) {
    await t.pusher.flush();
    await t.puller.pullAll();
  }
}

describe('two sides, one window', () => {
  it('different subjects edited on both sides in the same window: nothing lost', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune' }, [ROW2]: { [NAME]: 'Solaris' } });
    t.pusher.start();
    await settle(t);

    t.ng.nativeSet(ROW2, NAME, 'Solaris (1961)');
    t.local.userSet(ROW, NAME, 'Dune Messiah');
    await settle(t);

    expect(t.local.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.ng.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.local.valueOf(ROW2, NAME)).toBe('Solaris (1961)');
    expect(t.ng.valueOf(ROW2, NAME)).toBe('Solaris (1961)');
  });

  it('same subject, different fields, push runs first: both edits survive', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune', [AUTHOR]: 'Frank Herbert' } });
    t.pusher.start();
    await settle(t);

    // A native app fixes the author; a moment later the user renames the row.
    t.ng.nativeSet(ROW, AUTHOR, 'F. Herbert');
    t.local.userSet(ROW, NAME, 'Dune Messiah');
    await t.pusher.flush(); // push wins the race (50ms debounce vs 750ms pull)
    await settle(t);

    expect(t.ng.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.ng.valueOf(ROW, AUTHOR)).toBe('F. Herbert');
    expect(t.local.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.local.valueOf(ROW, AUTHOR)).toBe('F. Herbert');
  });

  it('same subject, different fields, pull runs first: both edits survive', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune', [AUTHOR]: 'Frank Herbert' } });
    t.pusher.start();
    await settle(t);

    t.ng.nativeSet(ROW, AUTHOR, 'F. Herbert');
    t.local.userSet(ROW, NAME, 'Dune Messiah');
    await t.puller.pullAll(); // pull wins the race
    await settle(t);

    expect(t.ng.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.ng.valueOf(ROW, AUTHOR)).toBe('F. Herbert');
    expect(t.local.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.local.valueOf(ROW, AUTHOR)).toBe('F. Herbert');
  });

  it('same field edited on both sides: one value wins, both sides agree, no loop', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune' } });
    t.pusher.start();
    await settle(t);

    t.ng.nativeSet(ROW, NAME, 'Dune (native)');
    t.local.userSet(ROW, NAME, 'Dune (user)');
    const writesBefore = t.ng.log.length;
    await settle(t);

    const ngValue = t.ng.valueOf(ROW, NAME);
    expect(['Dune (native)', 'Dune (user)']).toContain(ngValue);
    expect(t.local.valueOf(ROW, NAME)).toBe(ngValue);
    // Converged: a further round writes nothing.
    const writesAfter = t.ng.log.length;
    await settle(t);
    expect(t.ng.log.length).toBe(writesAfter);
    expect(writesAfter - writesBefore).toBeLessThanOrEqual(2);
  });

  it('a native predicate the bridge never wrote survives a user edit', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune' } });
    t.pusher.start();
    await settle(t);

    t.ng.nativeSet(ROW, NOTE, 'read this first');
    await settle(t);
    t.local.userSet(ROW, NAME, 'Dune Messiah');
    await settle(t);

    expect(t.ng.valueOf(ROW, NOTE)).toBe('read this first');
    expect(t.ng.valueOf(ROW, NAME)).toBe('Dune Messiah');
  });

  it('a row deleted natively while the user edits it: the deletion wins, and it is visible', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune' } });
    t.pusher.start();
    await settle(t);

    t.ng.nativeDelete(ROW);
    t.local.userSet(ROW, NAME, 'Dune Messiah');
    await t.puller.pullAll();
    await settle(t);

    expect(t.local.has(ROW)).toBe(false);
    expect(t.ng.valueOf(ROW, NAME)).toBeUndefined();
  });

  it('offline edits are queued, and land unchanged when the broker is back', async () => {
    const t = wire({ [ROW]: { [NAME]: 'Dune' } });
    t.pusher.start();
    await settle(t);

    t.ng.setOffline(true);
    t.local.userSet(ROW, NAME, 'Dune Messiah');
    t.local.userSet(ROW, AUTHOR, 'Frank Herbert');
    const failed = await t.pusher.flush();
    expect(failed.failed).toEqual([ROW]);

    t.ng.setOffline(false);
    await settle(t);

    expect(t.ng.valueOf(ROW, NAME)).toBe('Dune Messiah');
    expect(t.ng.valueOf(ROW, AUTHOR)).toBe('Frank Herbert');
  });
});
