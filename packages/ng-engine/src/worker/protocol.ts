/**
 * The wire between the page and the engine worker.
 *
 * Why there is a worker at all: the NextGraph engine is wasm, and every SPARQL
 * call runs synchronously inside it. On the main thread that competes with the
 * app's own rendering and with Atomic's Loro work — which froze the tab twice
 * while building this (PLAN.md section 13). NextGraph's own `api-web` runs the
 * wasm in a worker for the same reason, so this is the supported shape rather
 * than a workaround.
 *
 * Deliberately small: request/response with an id, plus one server-initiated
 * event for document changes. No streaming, no shared memory, nothing that
 * needs a framework.
 */

/** Everything the page can ask the engine to do. */
export type EngineRequest =
  | {
      id: number;
      method: 'open';
      /**
       * How to get a wallet. Bytes rather than a `File`: workers get neither
       * DOM nor pickers.
       *
       * `saved` is the returning-user path and is not interchangeable with
       * `wallet-file`. The local broker restores its wallet list from
       * `localStorage` on every load, and re-importing a wallet it already
       * holds fails (`NEXTGRAPH-ISSUES.md` B4). Reading a saved file to open a
       * wallet this browser already has is what forked the user's identity on
       * every reload.
       */
      params: (
        | {
            kind: 'wallet-file';
            walletFile: Uint8Array;
            /**
             * Keep the wallet in memory only.
             *
             * True for a wallet the user brings, which should leave nothing
             * behind in this origin. False for this browser's own remembered
             * wallet, so the import persists it into the local broker's list
             * and later loads can open it by name.
             */
            inMemory?: boolean;
          }
        | { kind: 'saved' }
        | {
            kind: 'create';
            /** A broker's `/.ng_bootstrap` object. */
            bootstrap?: unknown;
            /** An invitation link, for a broker that hands those out instead. */
            invitation?: string;
          }
      ) & {
        password: string;
        /** Which wallet, when the browser holds more than one. */
        walletName?: string;
        /**
         * The page's own URL, passed to `user_connect`.
         *
         * A worker has no `window.location`, and connecting is not optional:
         * the broker is what holds NextGraph data across sessions and it sends
         * the user's stores back only once a connection opens.
         */
        location?: string;
      };
    }
  | {
      id: number;
      method: 'findOrCreateDocument';
      params: { appClass: string; knownNuri?: string };
    }
  | {
      id: number;
      method: 'listDocuments';
      /** Every document of the user's carrying this class triple. */
      params: { appClass: string };
    }
  | { id: number; method: 'query'; params: { sparql: string; graph: string } }
  | {
      id: number;
      method: 'queryValues';
      params: { sparql: string; graph: string; variable: string };
    }
  | { id: number; method: 'update'; params: { sparql: string; graph: string } }
  | { id: number; method: 'subscribe'; params: { graph: string } }
  | { id: number; method: 'unsubscribe'; params: { graph: string } }
  | { id: number; method: 'close'; params: Record<string, never> };

export type OpenResult = {
  walletName: string;
  userId: string;
  privateStoreId?: string;
  /** True when no wallet existed and one was created for this browser. */
  created: boolean;
  /**
   * The new wallet's bytes, on creation only, so the page can save it.
   *
   * The page is where persistent storage lives, and a wallet that is never
   * saved cannot be carried to another device. This is not how the wallet is
   * reopened here, though: see the `saved` open kind.
   */
  walletFile?: Uint8Array;
  /** What the broker said, if anything. Undefined when no connection was made. */
  connection?: unknown;
  /**
   * The Atomic private key derived from the wallet.
   *
   * The wallet itself never leaves the worker. Only this key crosses, because
   * the page needs it to sign Atomic commits — a deliberately narrower thing to
   * hand out than the wallet it came from.
   */
  atomicPrivateKey: string;
};

export type EngineResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string; name?: string };

/** Unsolicited: the engine says a document changed. */
export type EngineEvent = { event: 'doc-changed'; graph: string };

export const isEngineEvent = (data: unknown): data is EngineEvent =>
  typeof data === 'object' &&
  data !== null &&
  (data as { event?: unknown }).event === 'doc-changed';

export const isEngineResponse = (data: unknown): data is EngineResponse =>
  typeof data === 'object' && data !== null && 'id' in data && 'ok' in data;
