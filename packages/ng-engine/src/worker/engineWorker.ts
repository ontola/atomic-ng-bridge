/**
 * The engine, in a worker.
 *
 * Everything NextGraph happens here: the wasm, the wallet, the session, every
 * SPARQL call. The page holds no engine state at all, which is the point — a
 * long query can no longer stall rendering.
 *
 * Two things still involve the page, and both are unavoidable:
 *
 * - **Storage.** The wasm services `localStorage`/`sessionStorage` by posting a
 *   message and awaiting an answer on a `MessagePort` (`NEXTGRAPH-ISSUES.md`
 *   A7). Inside a worker, a bare `postMessage` goes to the page, which is
 *   exactly where storage lives, so the page answers. `installNgStorageBridge`
 *   on a `Worker` target does that side.
 * - **The derived Atomic key.** The page signs Atomic commits, so it needs the
 *   key. The wallet stays here; only the derived key crosses.
 *
 * Bundled by the host app's bundler as a module worker. Vite needs
 * `vite-plugin-wasm` to apply to worker builds too (`worker.plugins`), which is
 * the one piece of configuration this costs.
 */

import { bindingsToTriples, bindingsToValues } from '../results.js';
import type { OpenedWalletV0 } from '../identity.js';
import { findOrCreateDocument, listDocuments, type NgSession } from '../session.js';
import { openSession } from './openSession.js';
import { probeWasmMethods, type NgWasm } from '../wasm.js';
import type {
  EngineEvent,
  EngineRequest,
  EngineResponse,
  OpenResult,
} from './protocol.js';

type Subscription = { close?: () => void };

let ng: NgWasm | undefined;
let session: (NgSession & { opened: OpenedWalletV0 }) | undefined;
const subscriptions = new Map<string, Subscription>();

const post = (message: EngineResponse | EngineEvent) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(
    message,
  );

async function engine(): Promise<NgWasm> {
  if (ng === undefined) {
    ng = (await import('@ng-org/lib-wasm')) as unknown as NgWasm;
    probeWasmMethods(ng);
  }

  return ng;
}

function requireSession(): NgSession & { opened: OpenedWalletV0 } {
  if (session === undefined) {
    throw new Error('The engine has no session yet: call `open` first.');
  }

  return session;
}

async function handle(request: EngineRequest): Promise<unknown> {
  switch (request.method) {
    case 'open': {
      const wasm = await engine();
      const opened = await openSession(wasm, request.params);

      session = opened.session;

      return opened.result;
    }

    case 'findOrCreateDocument': {
      const wasm = await engine();

      return findOrCreateDocument(wasm, requireSession(), request.params.appClass, {
        knownNuri: request.params.knownNuri,
      });
    }

    case 'listDocuments': {
      const wasm = await engine();

      return listDocuments(wasm, requireSession(), request.params.appClass);
    }

    case 'query': {
      const wasm = await engine();
      const raw = await wasm.sparql_query(
        requireSession().sessionId,
        request.params.sparql,
        undefined,
        request.params.graph,
      );

      // Subject is filled in by the caller, which knows what it asked for.
      return bindingsToTriples('', raw);
    }

    case 'queryValues': {
      const wasm = await engine();
      const raw = await wasm.sparql_query(
        requireSession().sessionId,
        request.params.sparql,
        undefined,
        request.params.graph,
      );

      return bindingsToValues(raw, request.params.variable);
    }

    case 'update': {
      const wasm = await engine();
      await wasm.sparql_update(
        requireSession().sessionId,
        request.params.sparql,
        request.params.graph,
      );

      return undefined;
    }

    case 'subscribe': {
      const wasm = await engine();
      const { graph } = request.params;

      if (subscriptions.has(graph)) {
        return undefined;
      }

      const handle = (await wasm.doc_subscribe(
        graph,
        requireSession().sessionId,
        () => post({ event: 'doc-changed', graph }),
      )) as Subscription | undefined;

      subscriptions.set(graph, handle ?? {});

      return undefined;
    }

    case 'unsubscribe': {
      const handle = subscriptions.get(request.params.graph);
      handle?.close?.();
      subscriptions.delete(request.params.graph);

      return undefined;
    }

    case 'close': {
      for (const handle of subscriptions.values()) {
        handle.close?.();
      }

      subscriptions.clear();

      return undefined;
    }
  }
}

self.addEventListener('message', event => {
  const request = (event as MessageEvent).data as EngineRequest | undefined;

  // The wasm's own storage messages travel over this same channel in the other
  // direction; anything without a `method` is not ours to answer.
  if (request === undefined || typeof request.method !== 'string') {
    return;
  }

  handle(request).then(
    value => post({ id: request.id, ok: true, value }),
    (error: unknown) =>
      post({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
      }),
  );
});
