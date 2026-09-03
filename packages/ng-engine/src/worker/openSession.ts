/**
 * Getting from "the page has a password" to "there is a live session", inside
 * the worker.
 *
 * Separate from `engineWorker.ts` because that file is message plumbing and
 * this is the part with judgement in it. Every branch below is a lesson that
 * cost a day (`NEXTGRAPH-ISSUES.md` B4), so it is worth being able to test it
 * without standing up a worker.
 */

import { deriveAtomicPrivateKey, type OpenedWalletV0 } from '../identity.js';
import {
  connectUser,
  createWalletFromInvitation,
  openSavedWallet,
  openWalletAndStartSession,
  type NgSession,
} from '../session.js';
import type { NgWasm } from '../wasm.js';
import type { EngineRequest, OpenResult } from './protocol.js';

export type OpenParams = Extract<EngineRequest, { method: 'open' }>['params'];

export type OpenedSession = {
  session: NgSession & { opened: OpenedWalletV0 };
  result: OpenResult;
};

export async function openSession(
  ng: NgWasm,
  params: OpenParams,
): Promise<OpenedSession> {
  const { password, walletName } = params;
  let session: NgSession & { opened: OpenedWalletV0 };
  let created = false;
  let walletFile: Uint8Array | undefined;

  switch (params.kind) {
    case 'saved':
      // The returning-user path. The wallet is already in the local broker,
      // restored from the page's `localStorage`, so it is opened by name.
      // Re-importing it from a saved file fails, and reading that failure as a
      // broken wallet is what used to mint a second identity on every reload.
      session = await openSavedWallet({
        ng,
        password,
        walletName,
        inMemory: false,
      });
      break;

    case 'wallet-file':
      // Handles both cases on its own: import the wallet if this browser has
      // never seen it, or open the held one by name if the local broker
      // already has it. That is what makes it the right path for a reload —
      // `wallet_create` does not persist the wallet into the broker's list
      // (`local_save: false`), so a freshly created wallet is not yet
      // openable by name and `saved` would fail on the very next load.
      session = await openWalletAndStartSession({
        ng,
        walletFile: params.walletFile,
        password,
        walletName,
        inMemory: params.inMemory ?? true,
      });
      break;

    case 'create': {
      const fresh = await createWalletFromInvitation({
        ng,
        bootstrap: params.bootstrap,
        invitation: params.invitation,
        password,
      });

      session = { ...fresh.session, opened: fresh.opened };
      created = true;

      try {
        walletFile = (await ng.wallet_get_file(fresh.walletName)) as Uint8Array;
      } catch {
        // Losing the exportable copy costs portability to another device, not
        // this session and not the data.
      }

      break;
    }
  }

  // Not optional, and not fatal either. The broker is what holds NextGraph data
  // across sessions, and it sends the user's stores back only once a connection
  // opens, so without this a reload finds nothing. But a broker that will not
  // have us is a degraded mirror, not a broken app: the Atomic side is durable
  // on its own, so the session is still worth returning.
  let connection: unknown;

  try {
    connection = await connectUser(ng, session, params.location);
  } catch {
    connection = undefined;
  }

  return {
    session,
    result: {
      walletName: session.walletName,
      userId: session.userId,
      privateStoreId: session.privateStoreId,
      created,
      walletFile,
      connection,
      // The wallet stays in the worker. Only this crosses, because the page
      // signs Atomic commits.
      atomicPrivateKey: await deriveAtomicPrivateKey(session.opened),
    },
  };
}
