import { describe, expect, it, vi } from 'vitest';
import { createWorkerEngine } from '../src/index.js';

/**
 * The worker client, against a fake worker.
 *
 * The real engine needs a browser; what is worth testing here is the wiring
 * that fails silently if it drifts: request/response correlation, error
 * propagation across the boundary, and the subscription bookkeeping. A dropped
 * correlation id means a promise that never settles, which looks exactly like a
 * slow engine.
 */
function fakeWorker() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: Record<string, unknown>[] = [];

  const worker = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MessageEvent) => void,
    ) => listeners.delete(listener),
    postMessage: (message: Record<string, unknown>) => sent.push(message),
    terminate: vi.fn(),
  } as unknown as Worker;

  const emit = (data: unknown) => {
    for (const listener of listeners) {
      listener({ data } as MessageEvent);
    }
  };

  return { worker, sent, emit };
}

describe('talking to the engine worker', () => {
  it('correlates each answer with its request', async () => {
    const { worker, sent, emit } = fakeWorker();
    const engine = createWorkerEngine({ worker });
    const transport = engine.transport('did:ng:o:doc');

    const first = transport.queryValues('SELECT ?a', 'a');
    const second = transport.queryValues('SELECT ?b', 'b');

    expect(sent).toHaveLength(2);
    // Answered out of order on purpose: ids, not arrival order, decide.
    emit({ id: sent[1]!.id, ok: true, value: ['second'] });
    emit({ id: sent[0]!.id, ok: true, value: ['first'] });

    expect(await first).toEqual(['first']);
    expect(await second).toEqual(['second']);
  });

  it('rethrows the workers error, keeping its name', async () => {
    const { worker, sent, emit } = fakeWorker();
    const engine = createWorkerEngine({ worker });
    const pending = engine.transport('did:ng:o:doc').update('INSERT DATA {}');

    emit({
      id: sent[0]!.id,
      ok: false,
      error: 'RepoNotFound',
      name: 'NgError',
    });

    await expect(pending).rejects.toThrow('RepoNotFound');
  });

  it('fills in the subject a query was asked about', async () => {
    const { worker, sent, emit } = fakeWorker();
    const engine = createWorkerEngine({ worker });
    const pending = engine
      .transport('did:ng:o:doc')
      .querySubject('did:ad:resource:1', 'SELECT ?p ?o');

    // The worker cannot know the subject, so it sends triples without one.
    emit({
      id: sent[0]!.id,
      ok: true,
      value: [
        {
          subject: '',
          predicate: 'https://atomicdata.dev/properties/name',
          object: { termType: 'literal', value: 'x' },
        },
      ],
    });

    expect((await pending)[0]!.subject).toBe('did:ad:resource:1');
  });

  it('routes document events to the listeners for that document', async () => {
    const { worker, sent, emit } = fakeWorker();
    const engine = createWorkerEngine({ worker });
    const mine = vi.fn();
    const other = vi.fn();

    const subscription = engine.transport('did:ng:o:mine').subscribe(mine);
    engine.transport('did:ng:o:other').subscribe(other);
    // Acknowledge both subscribe calls.
    for (const message of sent) {
      emit({ id: message.id, ok: true, value: undefined });
    }

    await subscription;
    emit({ event: 'doc-changed', graph: 'did:ng:o:mine' });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('unsubscribes from the worker only when the last listener leaves', async () => {
    const { worker, sent, emit } = fakeWorker();
    const engine = createWorkerEngine({ worker });
    const transport = engine.transport('did:ng:o:doc');

    const a = transport.subscribe(vi.fn());
    const b = transport.subscribe(vi.fn());

    for (const message of sent) {
      emit({ id: message.id, ok: true, value: undefined });
    }

    (await a).close();

    expect(sent.some(m => m.method === 'unsubscribe')).toBe(false);

    (await b).close();

    expect(sent.some(m => m.method === 'unsubscribe')).toBe(true);
  });

  it('ignores the wasm own storage traffic on the same channel', async () => {
    const { worker, sent, emit } = fakeWorker();
    const engine = createWorkerEngine({ worker });
    const pending = engine.transport('did:ng:o:doc').queryValues('SELECT ?s', 's');

    // A storage request from the wasm: no id, no ok. Must not be mistaken for
    // an answer, or the query settles with nonsense.
    emit({ method: 'local_get', key: 'wallet' });
    emit({ id: sent[0]!.id, ok: true, value: ['did:ad:1'] });

    expect(await pending).toEqual(['did:ad:1']);
  });
});
