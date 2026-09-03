/**
 * One NextGraph engine per page, shared.
 *
 * Sign-in and the mirror both need a wallet. When each opened its own, the page
 * ended up with *two* wallets and therefore two derived Atomic identities —
 * whichever finished first won the store, and the other's document was
 * unreachable (`RepoNotFound`). Observed live.
 *
 * So the engine lives here, once, behind a cached promise. Whoever asks first
 * decides how the wallet is obtained; everyone else gets that same session.
 *
 * What stays on this side of the engine, and why: the password, the saved
 * wallet file, and the broker's address. All three are storage, and storage
 * lives in the page whether the wasm runs here or in a worker
 * (`NEXTGRAPH-ISSUES.md` A7). What the engine hands back is a session and one
 * derived Atomic key. In worker mode the wallet itself never reaches the page.
 */

import {
  createPageEngine,
  createWorkerEngine,
  spawnEngineWorker,
  type NgEngineApi,
  type OpenResult,
} from '@tomic/ng-engine';
import { ngStatus } from './status.js';
import { walletPassword } from './walletPassword.js';
import { loadWallet, saveWallet } from './walletStorage.js';

const BROKER_BOOTSTRAP_URL = 'https://nextgraph.eu/.ng_bootstrap';

/**
 * An invitation from a broker of your own, if one is configured.
 *
 * The public broker refuses wallets it has not registered
 * (`NEXTGRAPH-ISSUES.md` B3), which makes durability untestable against it. A
 * self-hosted `ngd` prints an invitation link at startup; putting that here
 * points wallet creation at it instead, which is also what a real deployment
 * would do, since ELFA would run its own broker rather than the public one.
 */
const INVITATION_KEY = 'atomic.ngBridge.invitation';

/**
 * A broker's own bootstrap URL, if one is configured.
 *
 * Preferred over an invitation, because `ngd` publishes `/.ng_bootstrap` the
 * same way the public broker does and it is reusable, whereas the admin
 * invitation a broker prints at startup is single use: spend it on one wallet
 * and the next sign-in is rejected with a bare protocol error.
 */
const BOOTSTRAP_URL_KEY = 'atomic.ngBridge.bootstrapUrl';

/**
 * Set to `page` to run the wasm on the main thread instead of in a worker.
 *
 * The worker is the default because every SPARQL call runs synchronously inside
 * the wasm, and on the main thread that competes with the app's rendering and
 * with Atomic's own Loro work — which froze the tab twice while this was built.
 * The escape hatch exists because a host bundler that cannot build a wasm
 * worker would otherwise have no way to run at all.
 */
const ENGINE_MODE_KEY = 'atomic.ngBridge.engine';

function configured(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export type WalletSource =
  /** Reuse the wallet saved in this browser; create one if there is none. */
  | { kind: 'saved-or-new'; bootstrapUrl?: string }
  /** A `.ngw` the user brings. */
  | { kind: 'wallet-file'; walletFile: Uint8Array; password: string };

export type NgSessionHandle = {
  engine: NgEngineApi;
  /** What the engine reported when the wallet opened. */
  session: OpenResult;
  /** True when no wallet existed and one was created for this browser. */
  created: boolean;
  /** What the broker said, if anything. Undefined when no connection was made. */
  connection?: unknown;
};

let current: Promise<NgSessionHandle> | undefined;

/** The session, opening one if nobody has yet. */
export function ensureNgSession(
  source: WalletSource = { kind: 'saved-or-new' },
  report: (message: string) => void = () => undefined,
): Promise<NgSessionHandle> {
  current ??= acquire(source, report).catch(error => {
    // A failed attempt must not poison every later one: a user who cancels a
    // wallet file dialog should be able to try again.
    current = undefined;
    throw error;
  });

  return current;
}

/** Whether a session is already open, without starting one. */
export const hasNgSession = (): boolean => current !== undefined;

/** Drops the cached session. The next caller opens a fresh one. */
export const resetNgSession = (): void => {
  current = undefined;
};

function createEngine(report: (message: string) => void): NgEngineApi {
  if (configured(ENGINE_MODE_KEY) === 'page') {
    report(ngStatus('Loading NextGraph engine…'));

    return createPageEngine();
  }

  try {
    report(ngStatus('Starting NextGraph engine…'));

    return createWorkerEngine({ worker: spawnEngineWorker() });
  } catch (error) {
    // A bundler that cannot build the worker is a configuration problem, not a
    // reason to have no mirror at all. Falling back keeps the app working and
    // says so rather than failing mysteriously.
    report(
      `${ngStatus('Engine worker unavailable, running in the page')}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return createPageEngine();
  }
}

async function acquire(
  source: WalletSource,
  report: (message: string) => void,
): Promise<NgSessionHandle> {
  const engine = createEngine(report);
  // A worker has no `window.location`, so the page supplies it.
  const location = window.location.href;

  if (source.kind === 'wallet-file') {
    report(ngStatus('Opening your wallet…'));

    const session = await engine.open({
      kind: 'wallet-file',
      walletFile: source.walletFile,
      password: source.password,
      location,
    });

    return { engine, session, created: false, connection: session.connection };
  }

  const remembered = await loadWallet();

  if (remembered !== undefined) {
    report(ngStatus('Unlocking…'));

    try {
      // The saved file, and not `saved`, because the two are not
      // interchangeable: `wallet_create` does not persist a new wallet into
      // the local broker's list, so a wallet created on the previous load
      // cannot yet be opened by name. This path covers both states — it
      // imports the wallet when the broker has never seen it, and opens the
      // held one by name when it has, which is what stops a reload from
      // forking the user's identity (B4).
      //
      // Persistent rather than in-memory, so that import lands in the
      // broker's list and every later load is the cheap by-name open.
      const session = await engine.open({
        kind: 'wallet-file',
        walletFile: remembered.file,
        walletName: remembered.walletName,
        inMemory: false,
        password: await walletPassword(),
        location,
      });

      return { engine, session, created: false, connection: session.connection };
    } catch (error) {
      // Deliberately fatal, and it used to be the opposite. Falling through to
      // create a fresh wallet looks forgiving and is the most destructive thing
      // this file could do: a new wallet is a new NextGraph identity, with new
      // stores and no access to the documents the old one wrote.
      //
      // A wallet that will not open is a problem to show the user, not to route
      // around. Their Atomic data is untouched and local either way.
      const reason = error instanceof Error ? error.message : String(error);
      report(`${ngStatus('Your saved wallet could not be opened')}: ${reason}`);

      throw new Error(`Saved NextGraph wallet could not be opened: ${reason}`);
    }
  }

  const invitation = configured(INVITATION_KEY);
  let bootstrap: unknown;

  if (invitation === undefined) {
    report(ngStatus('Reaching the broker…'));
    const response = await fetch(
      source.bootstrapUrl ?? configured(BOOTSTRAP_URL_KEY) ?? BROKER_BOOTSTRAP_URL,
    );

    if (!response.ok) {
      throw new Error(`Broker bootstrap failed: ${response.status}`);
    }

    bootstrap = ((await response.json()) as { V0: { bootstrap: unknown } }).V0
      .bootstrap;
  }

  report(ngStatus('Creating your NextGraph identity…'));
  const session = await engine.open({
    kind: 'create',
    bootstrap,
    invitation,
    password: await walletPassword(),
    location,
  });

  // The engine hands the bytes back precisely because storage lives here.
  if (session.walletFile !== undefined) {
    try {
      await saveWallet({
        file: session.walletFile,
        walletName: session.walletName,
        savedAt: Date.now(),
      });
    } catch {
      // Losing the saved copy costs continuity next load, not data.
    }
  }

  return { engine, session, created: true, connection: session.connection };
}
