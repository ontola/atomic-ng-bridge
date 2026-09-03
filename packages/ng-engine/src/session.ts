/**
 * Wallet, session, document: the bootstrap the hosted wallet page would
 * otherwise do for us.
 *
 * The sequence mirrors NextGraph's own wallet app
 * (`nextgraph-rs/app/ui-common/src/routes/WalletLogin.svelte` and
 * `lib/Login.svelte`), which is the only documentation of it that exists:
 *
 *   wallet_read_file -> wallet_open_with_password -> wallet_import (first time
 *   on this device) or wallet_was_opened -> session_start -> user_connect
 *
 * Running this ourselves rather than delegating to the hosted wallet is the
 * decision in PLAN.md section 4, and it means this code touches the user's
 * wallet material. That is the security note PLAN.md section 9 item 3 owes.
 */

import { bindingsToValues } from './results.js';
import type { OpenedWalletV0 } from './identity.js';
import type { NgWasm } from './wasm.js';

/** What NextGraph hands back once a wallet is open. */
export type OpenedWallet = {
  V0: {
    wallet_id: string;
    personal_site: string;
    client?: unknown;
  };
};

export type NgSession = {
  /** Opaque; every wasm call needs it. */
  sessionId: unknown;
  /** The wallet id, which doubles as the wallet name. */
  walletName: string;
  /** The user's personal site id. */
  userId: string;
  /** The user's private store, the default home for new documents. */
  privateStoreId?: string;
};

type SessionResponse = {
  session_id?: unknown;
  private_store_id?: string;
  /**
   * The user id in its string form (`SessionInfoString.user`,
   * `engine/wallet/src/types.rs:135`).
   *
   * Not interchangeable with the wallet's `personal_site`, which is the same
   * identity as a `PubKey` object. `session_start` takes the object;
   * `user_connect` takes this string and aborts the wasm with `memory access
   * out of bounds` when handed the object (`NEXTGRAPH-ISSUES.md` A9). So the
   * session carries whichever form the next call needs.
   */
  user?: string;
};

export type OpenWalletOptions = {
  ng: NgWasm & {
    wallet_read_file: (file: Uint8Array) => Promise<unknown>;
  };
  /** Raw bytes of a `.ngw` wallet file. */
  walletFile: Uint8Array;
  password: string;
  /**
   * Which wallet this file is, when the caller knows.
   *
   * Used only if the local broker turns out to hold it already, so that the
   * right one is opened in a browser that has more than one.
   */
  walletName?: string;
  /**
   * Keep the wallet in memory only. Recommended for a spike: it leaves nothing
   * of the user's wallet behind in this origin's storage.
   */
  inMemory?: boolean;
};

/**
 * Opens a wallet file and starts a session, with no hosted wallet page.
 *
 * This is the step that decides whether the embedded-engine architecture is
 * viable at all (M0). It is deliberately the *file* path rather than wallet
 * creation: creating a wallet needs the pazzle/security-image UI, which is a
 * product decision, not a transport question.
 */
/**
 * The wallets the local broker holds, whichever shape the wasm hands back.
 *
 * `get_wallets` serializes a Rust `HashMap`, and `serde_wasm_bindgen` renders
 * that as a JS `Map` rather than a plain object. Reading it with
 * `Object.keys` therefore finds nothing, on a browser that has the wallet, and
 * the caller concludes there is no saved wallet and starts a new identity. The
 * published typings say `any`, so nothing catches this at compile time
 * (`NEXTGRAPH-ISSUES.md` A5).
 */
function walletEntries(raw: unknown): Map<string, { wallet?: unknown }> {
  if (raw instanceof Map) {
    return raw as Map<string, { wallet?: unknown }>;
  }

  if (raw !== null && typeof raw === 'object') {
    return new Map(Object.entries(raw as Record<string, { wallet?: unknown }>));
  }

  return new Map();
}

export type OpenSavedWalletOptions = {
  ng: NgWasm;
  password: string;
  /** Which wallet, when the browser holds more than one. Defaults to the only one. */
  walletName?: string;
  inMemory?: boolean;
};

/**
 * Opens a wallet the local broker already holds, without a file.
 *
 * This is the returning-user path, and the one that makes NextGraph data
 * outlive a page. The local broker persists its wallet list in `localStorage`
 * under `ng_wallets` and restores it on load, so a wallet created in an earlier
 * session is still there — it just has to be opened by name rather than
 * imported again.
 */
export async function openSavedWallet(
  options: OpenSavedWalletOptions,
): Promise<NgSession & { opened: OpenedWalletV0 }> {
  const { ng, password, walletName, inMemory = false } = options;

  // Picks up anything another tab (or an earlier load) wrote.
  await ng.wallets_reload();

  const wallets = walletEntries(await ng.get_wallets());
  const name = walletName ?? wallets.keys().next().value;
  const held = name === undefined ? undefined : wallets.get(name)?.wallet;

  if (name === undefined || held === undefined) {
    throw new Error(
      `No saved NextGraph wallet in this browser${
        wallets.size > 0 ? ` under the name ${name}` : ''
      }`,
    );
  }

  const opened = (await ng.wallet_open_with_password(
    held,
    password,
  )) as OpenedWallet;

  opened.V0.client = await ng.wallet_was_opened(opened);

  const personalSite = opened.V0.personal_site;
  const session = (await (inMemory
    ? ng.session_in_memory_start(name, personalSite)
    : ng.session_start(name, personalSite))) as SessionResponse;

  return {
    sessionId: session.session_id,
    walletName: name,
    userId: session.user ?? (personalSite as unknown as string),
    privateStoreId: session.private_store_id,
    opened: opened as unknown as OpenedWalletV0,
  };
}

export async function openWalletAndStartSession(
  options: OpenWalletOptions,
): Promise<NgSession & { opened: OpenedWalletV0 }> {
  const {
    ng,
    walletFile,
    password,
    walletName: expectedName,
    inMemory = true,
  } = options;

  // Every step below can fail with the same opaque error string, and which one
  // failed changes the diagnosis completely (a bad password, a wallet the local
  // broker already holds, a session that will not start). The SDK does not say,
  // so the step name is added here.
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new Error(
        `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // `wallet_read_file` reads like a parser and is not one: it refuses a wallet
  // the local broker already holds, with `WalletAlreadyAdded`
  // (`sdk/rust/src/local_broker.rs:2172`). That is the normal state for a
  // returning user, because the local broker restores its wallet list from
  // `localStorage` on every page load, so the file path is for a wallet this
  // browser has never seen. When the wallet is already known, opening it by
  // name is both correct and what NextGraph's own app does.
  //
  // Getting this wrong is expensive: the previous version treated the error as
  // "this wallet is broken" and made a new one, which silently forked the
  // user's identity on every reload and left their documents behind.
  let encryptedWallet: unknown;

  try {
    encryptedWallet = await ng.wallet_read_file(walletFile);
  } catch (error) {
    if (!String(error).includes('WalletAlreadyAdded')) {
      throw new Error(
        `wallet_read_file failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return openSavedWallet({ ng, password, walletName: expectedName, inMemory });
  }
  const opened = (await step('wallet_open_with_password', async () =>
    ng.wallet_open_with_password(encryptedWallet, password),
  )) as OpenedWallet;

  const walletName = opened.V0.wallet_id;
  const personalSite = opened.V0.personal_site;

  // Whether this wallet is already known is advisory; the error is
  // authoritative. `get_wallets()` can report nothing while the local broker
  // already holds the wallet — opening the same wallet twice in one page (the
  // sign-in flow and the mirror both do) then fails with `WalletAlreadyAdded`.
  // Treat that as "already imported", which is exactly what it means.
  const alreadyHeld = walletEntries(
    await step('get_wallets', () => ng.get_wallets()),
  );

  if (!alreadyHeld.has(walletName)) {
    try {
      opened.V0.client = await ng.wallet_import(
        encryptedWallet,
        opened,
        inMemory,
      );
    } catch (error) {
      if (!String(error).includes('WalletAlreadyAdded')) {
        throw error;
      }

      opened.V0.client = await step('wallet_was_opened', () =>
        ng.wallet_was_opened(opened),
      );
    }
  } else {
    opened.V0.client = await step('wallet_was_opened', () =>
      ng.wallet_was_opened(opened),
    );
  }

  const session = (await step('session_start', () =>
    inMemory
      ? ng.session_in_memory_start(walletName, personalSite)
      : ng.session_start(walletName, personalSite),
  )) as SessionResponse;

  return {
    sessionId: session.session_id,
    walletName,
    userId: session.user ?? (personalSite as unknown as string),
    privateStoreId: session.private_store_id,
    // Handed back so the caller can derive the Atomic identity from it
    // (`identity.ts`). It holds key material: do not log it or store it.
    opened: opened as unknown as OpenedWalletV0,
  };
}

/**
 * Connects the session to its broker.
 *
 * Not optional in practice, and in both directions: per `NEXTGRAPH-ISSUES.md`
 * B1 a browser session keeps no durable local graph, so without a connection
 * the data exists only for the lifetime of the page *and* an earlier session's
 * documents are never restored — the broker sends them back when the connection
 * opens, not before.
 *
 * `session.userId` must be the string form the session returned, not the
 * wallet's `personal_site` object (A9). Handed the object, this call does not
 * connect, and every later document call fails with `RepoNotFound` for what
 * looks like an unrelated reason.
 */
export async function connectUser(
  ng: NgWasm,
  session: NgSession,
  location?: string,
): Promise<unknown> {
  return ng.user_connect(ng.client_info(), session.userId, location ?? null);
}

/**
 * Whether this session can read a document yet.
 *
 * A fresh browser session starts with an empty local store and receives the
 * user's repos asynchronously once the broker connection opens, so a query for
 * a document the user certainly owns fails with `RepoNotFound` for the first
 * moments of a session. That is a wait, not an answer.
 */
export async function documentIsAvailable(
  ng: NgWasm,
  session: NgSession,
  nuri: string,
): Promise<boolean> {
  try {
    await ng.sparql_query(session.sessionId, 'ASK { ?s ?p ?o }', undefined, nuri);

    return true;
  } catch (error) {
    if (String(error).includes('RepoNotFound')) {
      return false;
    }

    throw error;
  }
}

/**
 * Waits for a known document to arrive from the broker.
 *
 * Resolves false if it has not appeared within the budget, which is the honest
 * answer when there is no broker holding it.
 */
export async function waitForDocument(
  ng: NgWasm,
  session: NgSession,
  nuri: string,
  attempts = 10,
  delayMs = 1_500,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await documentIsAvailable(ng, session, nuri)) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return false;
}

/**
 * The document to mirror into: the remembered one, else one found by its class
 * triple, else a new one.
 *
 * `knownNuri` matters more than it looks. Discovery alone is unreliable in a
 * fresh session, because the query runs against a store the broker has not
 * finished filling, and a discovery that comes back empty is indistinguishable
 * from "there is no document" — which is how a reload ends up creating a rival
 * document beside the real one. A remembered nuri turns that guess into a wait.
 */
/**
 * Every document of the user's carrying this app's class triple.
 *
 * Normally one. More than one means a previous session concluded the workspace
 * had no document and created a rival, which is the shape the discovery race
 * leaves behind (`NEXTGRAPH-ISSUES.md` B4). Worth being able to ask, both as a
 * diagnostic and so a test can assert it.
 */
export async function listDocuments(
  ng: NgWasm,
  session: NgSession,
  appClassIri: string,
): Promise<string[]> {
  const found = await ng.sparql_query(
    session.sessionId,
    `SELECT DISTINCT ?doc WHERE { GRAPH ?doc { ?s a <${appClassIri}> } }`,
    undefined,
    undefined,
  );

  return bindingsToValues(found, 'doc');
}

export type FindDocumentOptions = {
  /** The document this workspace used last time, if the caller remembers one. */
  knownNuri?: string;
  crdt?: string;
  className?: string;
  /** How long to wait for `knownNuri` to arrive from the broker. */
  waitAttempts?: number;
  waitDelayMs?: number;
};

export async function findOrCreateDocument(
  ng: NgWasm,
  session: NgSession,
  appClassIri: string,
  options: FindDocumentOptions = {},
): Promise<{ nuri: string; created: boolean }> {
  const {
    knownNuri,
    crdt = 'Graph',
    className = 'data:graph',
    waitAttempts,
    waitDelayMs,
  } = options;

  if (
    knownNuri !== undefined &&
    (await waitForDocument(ng, session, knownNuri, waitAttempts, waitDelayMs))
  ) {
    return { nuri: knownNuri, created: false };
  }

  const found = await ng.sparql_query(
    session.sessionId,
    `SELECT ?doc WHERE { GRAPH ?doc { ?s a <${appClassIri}> } }`,
    undefined,
    undefined,
  );

  const existing = bindingsToValues(found, 'doc')[0];

  if (existing !== undefined) {
    return { nuri: existing, created: false };
  }

  const nuri = await ng.doc_create(
    session.sessionId,
    crdt,
    className,
    'store',
    undefined,
  );

  await ng.sparql_update(
    session.sessionId,
    `INSERT DATA { GRAPH <${nuri}> { <${nuri}> a <${appClassIri}> } }`,
    nuri,
  );

  return { nuri, created: true };
}

/** What `decode_invitation` returns, in the shape the wallet app reads it. */
export type NgInvitation = {
  V0: {
    bootstrap: unknown;
    url?: string;
    name?: string;
    code?: { ChaCha20Key?: unknown };
  };
};

export type CreateWalletOptions = {
  ng: NgWasm;
  /**
   * An invitation link from a broker, e.g. what `ngd --save-key` prints.
   * Mutually exclusive with `bootstrap`.
   */
  invitation?: string;
  /**
   * A broker's bootstrap object, as served at `<broker>/.ng_bootstrap` under
   * `V0.bootstrap`. Equivalent to what an invitation decodes to, and the route
   * to a public broker that does not hand out invitation links.
   */
  bootstrap?: unknown;
  /** Registration code, when the broker requires one. */
  registrationCode?: unknown;
  password: string;
  /** Shown back to the user when unlocking; any non-empty string works. */
  securityText?: string;
  /**
   * Persist the wallet in this origin's storage. Off by default: a wallet the
   * page created should not outlive the experiment unless someone asks for it.
   */
  localSave?: boolean;
};

/**
 * Creates a wallet against a broker invitation, with no wallet UI.
 *
 * This exists so M0 can run unattended. The parameters mirror NextGraph's own
 * wallet app (`app/ui-common/src/routes/WalletCreate.svelte`) exactly, including
 * `pazzle_length: 0` and `mnemonic: false`, which is what the app itself uses
 * for the password-only path. A wallet still requires a broker to be created at
 * all: `core_bootstrap` comes from the invitation, and there is no
 * broker-less form of this call.
 *
 * Either an invitation link or a bootstrap object works. A public broker that
 * publishes `/.ng_bootstrap` (nextgraph.eu does) needs no invitation at all:
 * that endpoint's `V0.bootstrap` is exactly what an invitation decodes to.
 */
export async function createWalletFromInvitation(options: CreateWalletOptions): Promise<{
  walletName: string;
  userId: string;
  /** The encrypted wallet, so a caller can persist it if it wants to. */
  walletFile: unknown;
  /** Holds key material. Used to derive the Atomic identity; never persisted. */
  opened: OpenedWalletV0;
  session: NgSession;
}> {
  const {
    ng,
    invitation,
    bootstrap,
    registrationCode,
    password,
    securityText = 'atomic-ng-bridge spike wallet',
    localSave = false,
  } = options;

  if (invitation === undefined && bootstrap === undefined) {
    throw new Error('Pass either an invitation link or a broker bootstrap.');
  }

  // `decode_invitation` takes the code, not the link. NextGraph's own app pulls
  // it out of the `i` query parameter, and what a broker prints at startup is a
  // whole URL, so accept either and hand the SDK the part it wants.
  const code = invitation?.includes('/i/')
    ? invitation.slice(invitation.lastIndexOf('/i/') + 3)
    : invitation;

  const decoded =
    code === undefined
      ? undefined
      : ((await ng.decode_invitation(code)) as NgInvitation);

  const created = (await ng.wallet_create({
    pazzle_length: 0,
    security_txt: securityText,
    security_img: undefined,
    password,
    mnemonic: false,
    send_bootstrap: false,
    send_wallet: false,
    local_save: localSave,
    result_with_wallet_file: false,
    core_bootstrap: decoded?.V0.bootstrap ?? bootstrap,
    core_registration: decoded?.V0.code?.ChaCha20Key ?? registrationCode,
    additional_bootstrap: undefined,
    device_name: 'spike',
    pdf: false,
  })) as {
    wallet?: unknown;
    wallet_name: string;
    user: unknown;
    session_id: unknown;
    in_memory?: boolean;
  };

  // Open it once more to get the *sensitive* wallet: `wallet_create` returns
  // the encrypted form, and the Atomic identity is derived from key material
  // only the opened one carries (`identity.ts`).
  const opened = (await ng.wallet_open_with_password(
    created.wallet,
    password,
  )) as unknown as OpenedWalletV0;

  // `wallet_create` has already added the wallet, opened it and started a
  // session by the time it returns (`wallet_create_v0` in
  // `sdk/rust/src/local_broker.rs` does all three), so calling `wallet_import`
  // afterwards fails with `WalletAlreadyAdded`.
  //
  // One wrinkle: the create result carries `user` as a `PubKey` **object**,
  // while `user_connect` takes the *string* form and panics ("memory access out
  // of bounds") on anything else. `session_start` on the already-started
  // session is the way to get the string form, along with the private store id.
  let sessionId: unknown = created.session_id;
  let userId: string | undefined;
  let privateStoreId: string | undefined;

  try {
    const info = (await (localSave
      ? ng.session_start(created.wallet_name, created.user)
      : ng.session_in_memory_start(created.wallet_name, created.user))) as {
      session_id?: unknown;
      user?: string;
      private_store_id?: string;
    };

    sessionId = info.session_id ?? sessionId;
    userId = info.user;
    privateStoreId = info.private_store_id;
  } catch {
    // Already-started sessions may refuse a second start. The create result's
    // session is still valid; we just do not get the string user id, which
    // means `connectUser` cannot be called until one is obtained.
  }

  return {
    walletName: created.wallet_name,
    userId: userId ?? '',
    walletFile: created.wallet,
    opened,
    session: {
      sessionId,
      walletName: created.wallet_name,
      userId: userId ?? '',
      privateStoreId,
    },
  };
}
