/**
 * The Atomic identity, derived from the NextGraph wallet.
 *
 * One secret for the user: their wallet. The Atomic agent is a function of it,
 * so the same wallet produces the same `did:ad:agent:` subject on every device,
 * with nothing extra to back up. See `@tomic/ng-engine`'s `identity.ts` for why
 * this is derived rather than stored in the wallet's own third-party slot.
 *
 * The derivation itself happens wherever the engine runs, and this takes the
 * resulting key rather than the wallet. With the engine in a worker that is the
 * difference between the page holding one Atomic signing key and the page
 * holding the user's whole wallet.
 */

import { Agent, JSCryptoProvider, type Store } from '@tomic/lib';

export type WalletAgentResult = {
  agent: Agent;
  /** The derived `did:ad:agent:` subject. Always set, unlike `Agent.subject`. */
  subject: string;
  /** True when this agent was adopted by the store, false when one was already set. */
  adopted: boolean;
};

/**
 * Builds the wallet's Atomic agent and, if the store has none, adopts it.
 *
 * **It will not replace an agent the app already set.** Rights in Atomic are
 * per-agent: swapping identities underneath a workspace that was created by
 * another agent leaves the user unable to write to their own data. Logging in
 * with a wallet is something that has to happen *before* a workspace exists,
 * which makes it the app's decision, not the mirror's. When an agent is already
 * present this returns `adopted: false` and changes nothing.
 */
export async function useWalletAgent(
  store: Store,
  privateKey: string,
): Promise<WalletAgentResult> {
  const provider = new JSCryptoProvider(privateKey);
  const publicKey = await provider.getPublicKey();
  const subject = `did:ad:agent:${publicKey}`;
  const agent = new Agent(provider, subject);

  const existing = store.getAgent();

  if (existing !== undefined) {
    // Already this identity — sign-in ran first, which is the intended order.
    // Reporting that as "not adopted" would say the app owns the identity when
    // the wallet does.
    return { agent, subject, adopted: existing.subject === subject };
  }

  store.setAgent(agent);
  // The agent's own resource is a free-standing DID that exists nowhere but
  // here. Without this, anything that renders the current identity tries to
  // fetch it over the network and shows a permanent error — the same reason
  // data-browser's own guest-agent path registers it.
  store.registerLocalOnlyDrive(subject);

  return { agent, subject, adopted: true };
}
