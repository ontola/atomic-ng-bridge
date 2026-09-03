/**
 * The engine, as an interface with two implementations.
 *
 * `createPageEngine` runs the wasm on the main thread; `createWorkerEngine`
 * runs it in a worker and talks to it over `postMessage`. They are deliberately
 * the same shape, so the mirror above them cannot tell which one it has: the
 * bridge, the mapping and both sync directions are written against the
 * four-method transport and never see the engine at all (PLAN.md section 4).
 *
 * The worker is the better default. Every SPARQL call runs synchronously inside
 * the wasm, and on the main thread that competes with the app's rendering and
 * with Atomic's own Loro work, which froze the tab twice while this was being
 * built. The page implementation stays because it is simpler to debug, and
 * because a host whose bundler cannot build a wasm worker still has a way to
 * run.
 */

import type { NgEngineTransport } from './transport.js';
import type { EngineRequest, OpenResult } from './worker/protocol.js';

export type NgOpenParams = Extract<
  EngineRequest,
  { method: 'open' }
>['params'];

export type NgEngineApi = {
  /** Which implementation this is. Reported in diagnostics, never branched on. */
  readonly mode: 'page' | 'worker';
  /** Opens a wallet, starts a session, and connects to a broker. */
  open: (params: NgOpenParams) => Promise<OpenResult>;
  /** This app's document for the workspace, reopened or created. */
  findOrCreateDocument: (
    appClass: string,
    knownNuri?: string,
  ) => Promise<{ nuri: string; created: boolean }>;
  /** Every document of the user's carrying this app's class triple. */
  listDocuments: (appClass: string) => Promise<string[]>;
  /** A transport bound to one document. */
  transport: (graph: string) => NgEngineTransport;
  /** Releases the engine. A no-op on the page, terminates the worker. */
  terminate: () => void;
};
