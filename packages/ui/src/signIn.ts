/**
 * Wallet-first sign-in.
 *
 * The order here is the whole point, and it is not interchangeable:
 *
 *   wallet -> Atomic identity -> workspace -> mirror
 *
 * Rights in Atomic are per-agent, so a workspace belongs to whichever agent
 * created it. Sign in first and the workspace is the user's, on every device
 * that opens the same wallet. Create the workspace first — which is what the
 * demo route does — and the identity is stuck to that browser, because we
 * refuse to swap an agent out from under existing data.
 *
 * What a user sees: one button. Everything below happens without them being
 * told about agents, keys or DIDs.
 */

import { StoreEvents, core, server, type Store } from '@tomic/lib';
import { useWalletAgent } from './atomicAgent.js';
import { ensureNgSession } from './ngSession.js';

export type SignInSource =
  /** Reuse the wallet saved in this browser, or make one if there is none. */
  | { kind: 'saved-or-new'; bootstrapUrl?: string }
  /** A `.ngw` the user brings. The real ELFA case: their existing identity. */
  | { kind: 'wallet-file'; walletFile: Uint8Array; password: string };

export type SignInResult = {
  /** The `did:ad:agent:` subject derived from the wallet. */
  agentSubject: string;
  /** True when this browser had no wallet and one was created. */
  created: boolean;
};

/**
 * Opens (or creates) a wallet and adopts its Atomic identity.
 *
 * Goes through `ensureNgSession`, so the mirror and sign-in share one wallet
 * rather than racing to create two. Does not touch the workspace: see
 * `ensureWorkspace`.
 */
export async function signInWithWallet(
  store: Store,
  source: SignInSource = { kind: 'saved-or-new' },
  report: (message: string) => void = () => undefined,
): Promise<SignInResult> {
  const { session, created } = await ensureNgSession(source, report);
  const { subject } = await useWalletAgent(store, session.atomicPrivateKey);

  return { agentSubject: subject, created };
}

/**
 * Waits for the local database to finish switching to the signed-in agent.
 *
 * The client database is per agent: the app opens an anonymous one at boot and
 * reopens an encrypted one for the agent when `AgentChanged` fires
 * (`data-browser/src/helpers/initClientDb.ts`). That switch is asynchronous, so
 * anything written in the window between setting the agent and the switch
 * completing lands in the database that is about to be replaced.
 *
 * Observed as: a workspace created at sign-in works perfectly, and is gone
 * after the next page load, with the sidebar reporting that the drive was "not
 * found in local storage". Nothing errors, because the write did succeed. It
 * just succeeded somewhere the app will never look again.
 *
 * Resolves on the ready-again transition, or after `timeoutMs` if no switch
 * happens, which is the normal case when the agent did not actually change.
 */
async function waitForClientDb(
  store: Store,
  timeoutMs = 15_000,
  noSwitchMs = 1_500,
): Promise<void> {
  await new Promise<void>(resolve => {
    let sawSwitch = false;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      unsubscribe();
      clearTimeout(noSwitchTimer);
      clearTimeout(hardTimer);
      resolve();
    };

    const unsubscribe = store.on(StoreEvents.SyncStatusChanged, status => {
      if (!status.clientDbReady) {
        sawSwitch = true;

        return;
      }

      if (sawSwitch) {
        finish();
      }
    });

    // No switch observed: the agent was already the current one.
    const noSwitchTimer = setTimeout(() => {
      if (!sawSwitch) {
        finish();
      }
    }, noSwitchMs);

    // A switch that never completes must not block sign-in forever.
    const hardTimer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Makes sure the signed-in user has a workspace to work in.
 *
 * A local-only drive, owned by the wallet-derived agent, following the app's
 * own recipe: register it local-only *between* creation (which derives the
 * subject) and the first save (which must already route locally), or the save
 * tries to reach a server that is not there.
 */
export async function ensureWorkspace(
  store: Store,
  name = 'My workspace',
): Promise<string> {
  const current = store.getDrive();

  if (current !== undefined && store.isLocalOnlySubject(current)) {
    return current;
  }

  const agent = store.getAgent();

  if (agent === undefined) {
    throw new Error('Sign in before creating a workspace.');
  }

  // Before the first write, not after: see `waitForClientDb`.
  await waitForClientDb(store);

  const drive = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: {
      [core.properties.name]: name,
      [core.properties.description]:
        'Lives on this device, and mirrored into NextGraph.',
      [core.properties.write]: [agent.subject],
      [core.properties.read]: [agent.subject],
    },
  });

  store.registerLocalOnlyDrive(drive.subject);
  await drive.save();
  await store.createDefaultOntology(drive);
  store.setDrive(drive.subject);

  return drive.subject;
}
