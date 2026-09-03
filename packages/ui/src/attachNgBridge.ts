/**
 * Mirrors a local-only Atomic drive into a NextGraph document, live.
 *
 * Point it at an app's `Store` and a workspace and the whole of that
 * workspace — tables, forms, kanban, whatever the app puts there — is mirrored into
 * a NextGraph document as ordinary RDF, with no AtomicServer anywhere.
 *
 * Nothing here runs unless the bridge is explicitly enabled: this module is
 * dynamically imported by `useNgBridge`, so the ~3 MB (gzipped) NextGraph
 * engine is never in a normal user's bundle.
 *
 * Known limits, all documented in `atomic-ng-bridge/NEXTGRAPH-ISSUES.md`:
 * - In a browser, NextGraph keeps no durable local store (B1): durability comes
 *   from a broker, which restores the user's stores when the connection opens.
 *   That restore is asynchronous, which is why the document is remembered by
 *   nuri rather than rediscovered (B4). The Atomic side keeps working
 *   regardless — its OPFS store is the durable local copy.
 * - A self-created wallet is not registered with the public broker (B3), so
 *   syncing against `nextgraph.eu` needs a registered account.
 */

import type { Store } from '@tomic/lib';
import { ngStatus } from './status';
import {
  createAtomicStoreSink,
  createAtomicStoreSource,
} from '@tomic/ng-bridge/atomic';
import { createBridge, createIdbCursorStore, type Bridge } from '@tomic/ng-bridge';
import type {
  NgEngineApi,
  NgEngineTransport,
  OpenResult,
} from '@tomic/ng-engine';
import { useWalletAgent } from './atomicAgent.js';
import { rememberDocument, rememberedDocument } from './documentMemory.js';
import { ensureNgSession } from './ngSession.js';

/**
 * The mirror could not be set up, and the app should carry on regardless.
 *
 * Distinct from a bug: the common cause is a wallet with no broker that accepts
 * it, which makes NextGraph unavailable but leaves everything local intact.
 */
export class NgMirrorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NgMirrorUnavailableError';
  }
}

/**
 * The property a resource carries naming the drive it belongs to.
 *
 * Not in `@tomic/lib`'s generated ontology constants, but used throughout its
 * own source (`browser/lib/src/resource.ts`), so it is written out here.
 */
const DRIVE_PROPERTY = 'https://atomicdata.dev/properties/drive';

/** The class triple that lets us find this drive's document again (C1). */
const APP_CLASS = 'did:ng:z:AtomicDriveMirror';

const BROKER_BOOTSTRAP_URL = 'https://nextgraph.eu/.ng_bootstrap';

export type NgBridgeConnection =
  | {
      /** Create a throwaway wallet against a broker's published bootstrap. */
      kind: 'public-broker';
      bootstrapUrl?: string;
      /** Defaults to a generated, device-local password. See `walletStorage.ts`. */
      password: string;
    }
  | {
      kind: 'wallet-file';
      walletFile: Uint8Array;
      password: string;
    };

export type NgBridgeHandle = {
  bridge: Bridge;
  /**
   * The engine, so a caller can ask about documents other than this one.
   *
   * Same interface whether the wasm runs in this page or in a worker, which is
   * what lets a diagnostic keep working across that change.
   */
  engine: NgEngineApi;
  /** Whose Atomic key signs local commits: the wallet's, or the app's own. */
  identity: 'wallet' | 'app';
  /** Exposed so the document can be inspected while demonstrating. */
  transport: NgEngineTransport;
  /** The NextGraph document this drive mirrors into. */
  graph: string;
  session: OpenResult;
  stop: () => Promise<void>;
};

export type AttachNgBridgeOptions = {
  store: Store;
  /** The local-only drive to mirror. */
  drive: string;
  connection: NgBridgeConnection;
  onStatus?: (message: string) => void;
};

/**
 * Finds the document, giving the broker time to send the user's stores.
 *
 * After `user_connect` the session's repos arrive asynchronously, so asking
 * immediately after a reload fails with `RepoNotFound` even when the broker has
 * everything. Retrying briefly turns "not connected" into a short wait, which
 * is what actually happens.
 *
 * The remembered nuri is what makes that wait safe. Without it, a discovery
 * query that has simply arrived too early looks exactly like a workspace that
 * has never been mirrored, and the bridge answers by creating a second
 * document (see `documentMemory.ts`).
 */
async function findDocumentWithRetry(
  engine: NgEngineApi,
  drive: string,
  report: (message: string) => void,
  attempts = 8,
  delayMs = 2_000,
): Promise<{ nuri: string; created: boolean }> {
  const known = rememberedDocument(drive);
  let last: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await engine.findOrCreateDocument(APP_CLASS, known);
    } catch (error) {
      last = error;

      if (!String(error).includes('RepoNotFound')) {
        throw error;
      }

      report(ngStatus('Waiting for NextGraph to send your data…'));
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw last;
}

export async function attachNgBridge(
  options: AttachNgBridgeOptions,
): Promise<NgBridgeHandle> {
  const { store, drive, connection, onStatus } = options;
  const report = (message: string) => onStatus?.(message);

  // Shared with sign-in: one wallet per page, or the page ends up with two
  // identities and a document neither can reach (see `ngSession.ts`).
  const { engine, session } = await ensureNgSession(
    connection.kind === 'wallet-file'
      ? {
          kind: 'wallet-file',
          walletFile: connection.walletFile,
          password: connection.password,
        }
      : { kind: 'saved-or-new', bootstrapUrl: connection.bootstrapUrl },
    report,
  );

  // One secret: the Atomic signing identity is derived from the wallet, so the
  // user manages no second key. `adopted` is true both when we set it here and
  // when sign-in already set the same identity; it is false only when the app
  // brought an agent of its own, which we never replace (`atomicAgent.ts`).
  let identity: 'wallet' | 'app' = 'app';

  try {
    const { adopted } = await useWalletAgent(store, session.atomicPrivateKey);
    identity = adopted ? 'wallet' : 'app';
  } catch (error) {
    report(
      `${ngStatus('Wallet identity unavailable')}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  report(ngStatus('Opening document…'));

  let document: { nuri: string; created: boolean };

  try {
    document = await findDocumentWithRetry(engine, drive, report);
  } catch (error) {
    // `RepoNotFound` here means the wallet's own stores are not present in this
    // session, and the SDK reports the same error for every cause. The retry
    // above separates them: a broker that has our data but has not finished
    // sending it (transient, and the common case after a reload), or no broker
    // connection at all, in which case there is nothing to wait for and
    // NextGraph keeps nothing across a reload (B1/B3).
    //
    // Either way the Atomic side is fully durable and the app keeps working, so
    // this is reported rather than thrown at the user as data loss.
    throw new NgMirrorUnavailableError(
      String(error).includes('RepoNotFound')
        ? 'NextGraph has no store for this wallet yet. It needs a broker that accepts it; your data is safe on this device meanwhile.'
        : String(error),
    );
  }

  // So the next session reopens this document instead of making another.
  rememberDocument(drive, document.nuri);

  const transport = engine.transport(document.nuri);

  const cursors = await createIdbCursorStore({ drive });

  const bridge = createBridge({
    graph: document.nuri,
    transport,
    cursors,
    source: createAtomicStoreSource({
      store,
      // This workspace's resources, and nothing else. Without a scope the
      // bridge would mirror everything the store touches, including the
      // bootstrap ontologies fetched from atomicdata.dev.
      //
      // Resources carry the drive they belong to, so the scope reads that
      // rather than guessing. `getResourceLoading` is the synchronous view: a
      // resource the store has not seen yet reports no drive and is skipped,
      // and the change event that made us look comes round again once it has
      // loaded.
      shouldMirror: subject => {
        if (subject === drive) {
          return true;
        }

        const owner = store.getResourceLoading(subject).get(DRIVE_PROPERTY) as
          | string
          | undefined;

        return owner === drive;
      },
    }),
    sink: createAtomicStoreSink({ store, drive }),
    // NextGraph-native subjects (`did:ng:…`) are not ours to materialize as
    // Atomic resources: the document's own marker triple is one, and anything a
    // NextGraph-native app writes with its own subjects would be another. We
    // mirror Atomic subjects, and read the rest as data.
    shouldPull: subject => !subject.startsWith('did:ng:'),
    onWarning: warning =>
      report(`${warning.kind}: ${warning.property} (${warning.subject})`),
  });

  report(ngStatus('Syncing…'));
  await bridge.start();
  report(ngStatus('Live'));

  const handle = {
    bridge,
    engine,
    identity,
    transport,
    graph: document.nuri,
    session,
    stop: async () => {
      await bridge.stop();
    },
  };

  // A demo diagnostic, not an API: lets the document be queried from the
  // console (or an automation driver) to show that the data really is in
  // NextGraph, rather than asking an audience to take it on faith.
  (window as unknown as { __ngBridge?: NgBridgeHandle }).__ngBridge = handle;

  return handle;
}
