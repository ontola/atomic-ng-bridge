import { useCallback, useEffect, useState, type JSX } from 'react';
import { StoreEvents, type Store } from '@tomic/lib';
import { styled } from 'styled-components';
import { NgSignIn } from './NgSignIn.js';
import { ngStatus } from './status';
import { useNgBridge } from './useNgBridge';

/**
 * A small badge showing what the NextGraph mirror is doing.
 *
 * Deliberately visible rather than silent. Two of the honest costs of the
 * mirror are invisible otherwise: sync only runs while the app is open, and the
 * NextGraph side depends on a broker being reachable (see
 * `atomic-ng-bridge/PLAN.md` section 12). A user who cannot tell whether their
 * data has reached the other system has been given a promise the app cannot
 * keep.
 *
 * Renders nothing at all when the bridge is off, which is every normal session.
 */
export type NgBridgeBadgeProps = {
  /** The app's store. Its current drive is what gets mirrored. */
  store: Store;
  /**
   * Where to go once signed in. Defaults to opening the new workspace.
   *
   * The default assumes data-browser's URL shape (`/app/show?subject=…`), which
   * is the one piece of host-app knowledge in this package. Any other host
   * passes its own; a host that would rather not move passes a no-op.
   */
  onSignedIn?: (info: { agentSubject: string; drive: string }) => void;
  /**
   * Offer wallet-first sign-in when nobody is signed in yet.
   *
   * On by default, because signing in *before* a workspace exists is what makes
   * the identity portable: a workspace belongs to the agent that created it,
   * and the mirror will not swap that agent out afterwards.
   */
  signIn?: boolean;
};

export function NgBridgeBadge({
  store,
  signIn = true,
  onSignedIn: onSignedInProp,
}: NgBridgeBadgeProps): JSX.Element | null {
  const { enabled, message, graph, pending, error, protection, protectWithPasskey } =
    useNgBridge(store);
  const [signedIn, setSignedIn] = useState(() => store.getAgent() !== undefined);
  // The store hydrates its agent from IndexedDB after mount, so "no agent" is
  // not yet an answer. Without this wait, a returning user is shown the sign-in
  // screen for a moment before it vanishes under them.
  const [resolved, setResolved] = useState(() => store.getAgent() !== undefined);

  useEffect(() => {
    if (resolved) {
      return;
    }

    const timer = setTimeout(() => setResolved(true), 600);

    return () => clearTimeout(timer);
  }, [resolved]);
  const onSignedIn = useCallback(
    (info: { agentSubject: string; drive: string }) => {
      setSignedIn(true);

      if (onSignedInProp !== undefined) {
        onSignedInProp(info);

        return;
      }

      // Land the user in the workspace they just made: signing in and then
      // being left on a welcome screen reads as "nothing happened".
      //
      // Deliberately *not* a full page load. A reload here races the workspace
      // still being written to local storage, and it destroys the NextGraph
      // session, whose stores do not survive a reload without a broker (B4).
      // pushState keeps both alive; the popstate event is what makes the app's
      // router notice.
      history.pushState({}, '', `/app/show?subject=${encodeURIComponent(info.drive)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    [onSignedInProp],
  );

  // The store hydrates its agent asynchronously (IndexedDB), so reading once at
  // mount says "signed out" for a returning user and puts the sign-in panel in
  // front of someone who already signed in.
  useEffect(
    () =>
      store.on(StoreEvents.AgentChanged, agent => {
        setSignedIn(agent !== undefined);
        setResolved(true);
      }),
    [store],
  );

  if (!enabled) {
    return null;
  }

  if (signIn && !signedIn) {
    return resolved ? <NgSignIn store={store} onSignedIn={onSignedIn} /> : null;
  }

  const state = error !== undefined ? 'error' : pending > 0 ? 'busy' : 'live';

  // No template literals and no bare string literals here: `wuchale` extracts
  // both (including in script scope) and an unextracted one renders as
  // `[i18n-404:…]`. Every fixed string goes through `ngStatus`, which the
  // extractor is configured to ignore.
  // The label stays short enough to read at a glance: a full NextGraph error is
  // a sentence and a half, which overflowed the pill. The detail moves to the
  // tooltip, where there is room for it.
  const parts = [ngStatus('NextGraph:'), message];

  if (pending > 0) {
    parts.push(ngStatus('·'), String(pending), ngStatus('pending'));
  }

  const label = parts.join(ngStatus(' '));

  // Offered, not forced: WebAuthn needs a user gesture, and a fingerprint
  // prompt nobody asked for on page load would be both broken and rude. Shown
  // only while the password is still the localStorage stopgap.
  const offerPasskey = protection === 'local-storage';

  return (
    <Badge $state={state} title={error ?? graph ?? ngStatus('No document yet')}>
      <Dot $state={state} />
      <span>{label}</span>
      {protection === 'passkey' ? <Lock title={ngStatus('Wallet unlocked with a passkey')}>🔑</Lock> : null}
      {offerPasskey ? (
        <Action type='button' onClick={() => void protectWithPasskey()}>
          {ngStatus('Protect with passkey')}
        </Action>
      ) : null}
    </Badge>
  );
}

type StateProps = { $state: 'live' | 'busy' | 'error' };

const colorFor = (state: StateProps['$state']) =>
  state === 'error' ? '#c0392b' : state === 'busy' ? '#e67e22' : '#27ae60';

// Deliberately theme-free: this badge is mounted next to the router, outside
// the app's ThemeProvider, so `p.theme` is empty here and reading it crashes
// the whole tree. `color-scheme`-aware CSS colors keep it legible in both
// themes without needing the theme context.
const Badge = styled.div<StateProps>`
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  border: 1px solid light-dark(rgb(0 0 0 / 12%), rgb(255 255 255 / 20%));
  background: light-dark(#fff, #1c1c1c);
  color: light-dark(#333, #ddd);
  color-scheme: light dark;
  font-size: 0.8rem;
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
  max-width: min(24rem, 60vw);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const Dot = styled.span<StateProps>`
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${p => colorFor(p.$state)};
`;

const Action = styled.button`
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: light-dark(rgb(0 0 0 / 6%), rgb(255 255 255 / 12%));
  }
`;

const Lock = styled.span`
  font-size: 0.85rem;
  line-height: 1;
`;
