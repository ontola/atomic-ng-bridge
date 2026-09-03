/**
 * The engine, on the main thread.
 *
 * The same interface the worker implementation offers, so callers choose one
 * and nothing above them changes. See `engine.ts` for why the worker is the
 * better default and why this one is kept.
 */

import { createNgTransport } from './transport.js';
import { findOrCreateDocument, listDocuments, type NgSession } from './session.js';
import type { OpenedWalletV0 } from './identity.js';
import { installNgStorageBridge } from './storage-bridge.js';
import { probeWasmMethods, type NgWasm } from './wasm.js';
import { openSession } from './worker/openSession.js';
import type { NgEngineApi, NgOpenParams } from './engine.js';
import type { NgEngineTransport } from './transport.js';
import type { OpenResult } from './worker/protocol.js';

export function createPageEngine(): NgEngineApi {
  let ng: NgWasm | undefined;
  let session: (NgSession & { opened: OpenedWalletV0 }) | undefined;

  const requireSession = (): NgSession & { opened: OpenedWalletV0 } => {
    if (session === undefined || ng === undefined) {
      throw new Error('The engine has no session yet: call `open` first.');
    }

    return session;
  };

  return {
    mode: 'page',

    open: async (params: NgOpenParams): Promise<OpenResult> => {
      ng = (await import('@ng-org/lib-wasm')) as unknown as NgWasm;

      // Before any other SDK call, or every call hangs silently (A7).
      installNgStorageBridge();
      probeWasmMethods(ng);

      const opened = await openSession(ng, params);
      session = opened.session;

      return opened.result;
    },

    findOrCreateDocument: (appClass, knownNuri) =>
      findOrCreateDocument(ng!, requireSession(), appClass, { knownNuri }),

    listDocuments: appClass => listDocuments(ng!, requireSession(), appClass),

    transport: (graph): NgEngineTransport =>
      createNgTransport({
        ng: ng!,
        sessionId: requireSession().sessionId,
        graph,
        // Already probed in `open`; probing per document is noise.
        skipProbe: true,
      }),

    terminate: () => undefined,
  };
}
