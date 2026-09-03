/**
 * "Continue with NextGraph" — the whole sign-in, as one panel.
 *
 * Shown when the mirror is enabled and nobody is signed in. Everything the user
 * needs is here: use the wallet this browser already has, bring a `.ngw`, or
 * get a NextGraph identity if they have none. Nothing about Atomic agents, DIDs
 * or keys appears, because none of it is theirs to manage.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { Store } from '@tomic/lib';
import { styled } from 'styled-components';
import { ngStatus } from './status.js';
import { ensureWorkspace, signInWithWallet, type SignInSource } from './signIn.js';
import { loadWallet } from './walletStorage.js';

export type NgSignInProps = {
  store: Store;
  /** Called once the user has an identity and a workspace. */
  onSignedIn: (info: { agentSubject: string; drive: string }) => void;
  /** Name for a workspace created on first sign-in. */
  workspaceName?: string;
};

export function NgSignIn({
  store,
  onSignedIn,
  workspaceName,
}: NgSignInProps): JSX.Element {
  const [hasSaved, setHasSaved] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadWallet().then(saved => setHasSaved(saved !== undefined));
  }, []);

  const run = useCallback(
    async (source: SignInSource) => {
      setError(undefined);

      try {
        const result = await signInWithWallet(store, source, setBusy);
        setBusy(ngStatus('Preparing your workspace…'));
        const drive = await ensureWorkspace(store, workspaceName);
        onSignedIn({ agentSubject: result.agentSubject, drive });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(undefined);
      }
    },
    [store, onSignedIn, workspaceName],
  );

  const onFile = useCallback(
    async (file: File) => {
      const password = window.prompt(ngStatus('Wallet password')) ?? '';
      await run({
        kind: 'wallet-file',
        walletFile: new Uint8Array(await file.arrayBuffer()),
        password,
      });
    },
    [run],
  );

  return (
    <Backdrop>
      <Panel>
        <h2>{ngStatus('Continue with NextGraph')}</h2>
        <p>
          {ngStatus(
            'Your NextGraph wallet is your identity here. Nothing else to create, and nothing else to remember.',
          )}
        </p>

        {busy !== undefined ? (
          <Status>{busy}</Status>
        ) : (
          <Actions>
            <Primary
              type='button'
              onClick={() => void run({ kind: 'saved-or-new' })}
            >
              {hasSaved
                ? ngStatus('Continue')
                : ngStatus('Create a NextGraph identity')}
            </Primary>

            <Secondary
              type='button'
              onClick={() => fileInput.current?.click()}
            >
              {ngStatus('Open a wallet file…')}
            </Secondary>

            <input
              ref={fileInput}
              type='file'
              accept='.ngw,application/octet-stream'
              hidden
              onChange={event => {
                const file = event.target.files?.[0];

                if (file !== undefined) {
                  void onFile(file);
                }
              }}
            />
          </Actions>
        )}

        {error !== undefined ? <ErrorText>{error}</ErrorText> : null}

        <Fine>
          {ngStatus(
            'Your workspace lives on this device and is mirrored into NextGraph while the app is open.',
          )}
        </Fine>
      </Panel>
    </Backdrop>
  );
}

// Theme-free, like the badge: this renders next to the router, outside the
// app's ThemeProvider, where reading `p.theme` throws.
//
// The backdrop is opaque on purpose. A transparent full-screen layer let the
// page underneath show through, so the app's own welcome screen and this one
// were drawn on top of each other, buttons and all. Signing in is a screen, not
// an overlay.
const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 99998;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  color-scheme: light dark;
  background: light-dark(#f7f8fa, #0f1013);
`;

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: min(32rem, 100%);
  padding: 2rem;
  border-radius: 14px;
  border: 1px solid light-dark(rgb(0 0 0 / 8%), rgb(255 255 255 / 12%));
  background: light-dark(#fff, #17181c);
  box-shadow: 0 12px 40px light-dark(rgb(0 0 0 / 10%), rgb(0 0 0 / 45%));
  color: light-dark(#1b1c1f, #e9eaee);
  font: 15px/1.55 system-ui, sans-serif;

  h2 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: -0.01em;
  }

  p {
    margin: 0;
    color: light-dark(#4b5058, #a6abb5);
  }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-top: 0.5rem;
`;

const Primary = styled.button`
  padding: 0.6rem 1.1rem;
  border-radius: 8px;
  border: none;
  background: light-dark(#1a1a1a, #eee);
  color: light-dark(#fff, #111);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
`;

const Secondary = styled.button`
  padding: 0.6rem 1.1rem;
  border-radius: 8px;
  border: 1px solid light-dark(rgb(0 0 0 / 25%), rgb(255 255 255 / 30%));
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
`;

const Status = styled.p`
  && {
    opacity: 1;
    font-variant-numeric: tabular-nums;
  }
`;

const ErrorText = styled.p`
  && {
    color: #c0392b;
    opacity: 1;
  }
`;

const Fine = styled.p`
  && {
    margin-top: 1rem;
    font-size: 0.85rem;
    opacity: 0.65;
  }
`;
