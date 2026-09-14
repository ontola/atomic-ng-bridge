/**
 * The engine behind NextGraph's own hosted wallet, through `@ng-org/web`.
 *
 * This is NextGraph's "third-party mode": the app is opened inside the wallet
 * page at nextgraph.net, which owns the wallet, the session and the broker
 * connection, and hands the app a session id over `postMessage`. Every call on
 * the `ng` object is forwarded to that page. No wallet material, no password
 * and no broker address ever reach this app.
 *
 * Same interface as the embedded engines (`engine.ts`), so the mirror above it
 * does not change. What differs: `open` takes no wallet, and on a top-level
 * page it does not return at all, because `init()` navigates the page to the
 * wallet, which then loads this app again in a frame, where `open` resolves.
 *
 * Kept as one of three engines rather than the only one: the embedded engine
 * still runs against a broker of one's own with no hosted page in the loop
 * (PLAN.md section 4), and its worker keeps SPARQL off the main thread.
 */

import type { NgEngineApi, NgOpenParams } from './engine.js';
import { findOrCreateDocument, listDocuments, type NgSession } from './session.js';
import { ensureStoredIdentity } from './storedIdentity.js';
import { createNgTransport, type NgEngineTransport } from './transport.js';
import type { NgWasm } from './wasm.js';
import type { OpenResult } from './worker/protocol.js';

/** What the wallet page hands back once the user is signed in. */
export type HostedSession = {
  session_id: unknown;
  private_store_id?: string;
  protected_store_id?: string;
  public_store_id?: string;
  user?: string;
  [key: string]: unknown;
};

/** The slice of `@ng-org/web` this engine uses. */
export type WebSdk = {
  init: (
    callback: ((event: { status: string; session: HostedSession }) => void) | null,
    singleton: boolean,
    accessRequests: unknown,
  ) => Promise<void>;
  ng: NgWasm;
};

export const HOSTED_WALLET_ORIGIN = 'https://nextgraph.net';

export type CreateWebEngineOptions = {
  /** How to load the SDK. Tests hand in a stub; the default imports the package. */
  sdk?: () => Promise<WebSdk>;
};

const loadWebSdk = async (): Promise<WebSdk> =>
  (await import('@ng-org/web')) as unknown as WebSdk;

/** True when this page is the wallet's frame rather than a top-level tab. */
export const insideHostedWallet = (): boolean =>
  typeof window !== 'undefined' && window.self !== window.top;

export function createWebEngine(
  options: CreateWebEngineOptions = {},
): NgEngineApi {
  let ng: NgWasm | undefined;
  let session: NgSession | undefined;

  const requireSession = (): NgSession => {
    if (session === undefined || ng === undefined) {
      throw new Error('The engine has no session yet: call `open` first.');
    }

    return session;
  };

  return {
    mode: 'web',

    open: async (params: NgOpenParams): Promise<OpenResult> => {
      if (params.kind !== 'web') {
        throw new Error(
          'The hosted-wallet engine opens no wallet of its own: pass { kind: "web" }.',
        );
      }

      const sdk = await (options.sdk ?? loadWebSdk)();
      ng = sdk.ng;

      // On a top-level page `init` navigates away and this never resolves;
      // the app is reloaded inside the wallet's frame, where it does.
      const hosted = await new Promise<HostedSession>((resolve, reject) => {
        sdk
          .init(
            event => {
              if (event.status === 'loggedin') {
                resolve(event.session);
              }
            },
            true,
            null,
          )
          .catch(reject);
      });

      session = {
        sessionId: hosted.session_id,
        walletName: HOSTED_WALLET_ORIGIN,
        userId: hosted.user ?? '',
        privateStoreId: hosted.private_store_id,
      };

      const identity = await ensureStoredIdentity(ng, session);

      return {
        walletName: session.walletName,
        userId: session.userId,
        privateStoreId: session.privateStoreId,
        created: identity.created,
        // The wallet page holds the broker connection; nothing to report.
        connection: undefined,
        atomicPrivateKey: identity.privateKey,
      };
    },

    findOrCreateDocument: (appClass, knownNuri, workspace) =>
      findOrCreateDocument(ng!, requireSession(), appClass, { knownNuri, workspace }),

    listDocuments: appClass => listDocuments(ng!, requireSession(), appClass),

    transport: (graph): NgEngineTransport =>
      createNgTransport({
        ng: ng!,
        sessionId: requireSession().sessionId,
        graph,
        // The proxy has no own properties to probe; every name resolves.
        skipProbe: true,
      }),

    terminate: () => undefined,
  };
}
