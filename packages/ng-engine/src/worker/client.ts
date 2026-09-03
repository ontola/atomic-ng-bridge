/**
 * The page's side of the engine worker.
 *
 * Gives back the same `NgTransport` the in-page engine does, so nothing above
 * it changes: the bridge, the mapping and both sync directions cannot tell
 * which one they are talking to. That was the point of putting a four-method
 * seam there in the first place (PLAN.md section 4).
 */

import type { NgSubscription, Triple } from '@tomic/ng-bridge';
import type { NgEngineApi } from '../engine.js';
import { installNgStorageBridge } from '../storage-bridge.js';
import {
  isEngineEvent,
  isEngineResponse,
  type EngineRequest,
  type OpenResult,
} from './protocol.js';

/** The worker implementation of the shared engine interface (`engine.ts`). */
export type WorkerEngine = NgEngineApi;

export type WorkerEngineOptions = {
  /**
   * The worker running `engineWorker.ts`.
   *
   * Constructed by the host app, because only it knows how its bundler spells
   * worker URLs — in Vite:
   * `new Worker(new URL('@tomic/ng-engine/worker', import.meta.url), { type: 'module' })`.
   */
  worker: Worker;
};

export function createWorkerEngine(options: WorkerEngineOptions): WorkerEngine {
  const { worker } = options;

  // The wasm asks the *page* for storage, from inside the worker (A7). Same
  // handler as the in-page engine, pointed at the worker instead of `window`.
  installNgStorageBridge({ target: worker as unknown as Window });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Map<string, Set<() => void>>();

  worker.addEventListener('message', event => {
    const data = (event as MessageEvent).data;

    if (isEngineEvent(data)) {
      for (const listener of listeners.get(data.graph) ?? []) {
        listener();
      }

      return;
    }

    if (!isEngineResponse(data)) {
      return; // A storage message, answered by the bridge above.
    }

    const waiting = pending.get(data.id);

    if (waiting === undefined) {
      return;
    }

    pending.delete(data.id);

    if (data.ok) {
      waiting.resolve(data.value);
    } else {
      const error = new Error(data.error);

      if (data.name !== undefined) {
        error.name = data.name;
      }

      waiting.reject(error);
    }
  });

  const call = <T>(request: Omit<EngineRequest, 'id'>): Promise<T> => {
    const id = nextId++;

    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
      worker.postMessage({ ...request, id } as EngineRequest);
    });
  };

  return {
    mode: 'worker',

    open: params => call<OpenResult>({ method: 'open', params }),

    findOrCreateDocument: (appClass, knownNuri) =>
      call<{ nuri: string; created: boolean }>({
        method: 'findOrCreateDocument',
        params: { appClass, knownNuri },
      }),

    listDocuments: appClass =>
      call<string[]>({ method: 'listDocuments', params: { appClass } }),

    transport: graph => ({
      // Carried so the worker transport is the same type as the in-page one,
      // rather than a look-alike the callers have to tell apart.
      graph,

      query: sparql => call<Triple[]>({ method: 'query', params: { sparql, graph } }),

      querySubject: async (subject, sparql) => {
        const triples = await call<Triple[]>({
          method: 'query',
          params: { sparql, graph },
        });

        // The worker cannot know which subject was asked for, so it leaves the
        // field empty and the caller fills it in.
        return triples.map(triple => ({ ...triple, subject }));
      },

      queryValues: (sparql, variable) =>
        call<string[]>({
          method: 'queryValues',
          params: { sparql, graph, variable },
        }),

      update: sparql =>
        call<void>({ method: 'update', params: { sparql, graph } }),

      subscribe: async (callback: () => void): Promise<NgSubscription> => {
        const forGraph = listeners.get(graph) ?? new Set();
        forGraph.add(callback);
        listeners.set(graph, forGraph);

        await call<void>({ method: 'subscribe', params: { graph } });

        return {
          close: () => {
            forGraph.delete(callback);

            if (forGraph.size === 0) {
              void call<void>({ method: 'unsubscribe', params: { graph } });
            }
          },
        };
      },

      close: async () => {
        await call<void>({ method: 'close', params: {} });
      },
    }),

    terminate: () => worker.terminate(),
  };
}
