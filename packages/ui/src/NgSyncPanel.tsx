/**
 * The NextGraph mirror, on the app's own Sync screen.
 *
 * The floating badge answers "is it working right now". This answers the
 * questions someone actually opens a settings page with: where does my data
 * live, what is it synced to, what does that depend on, and how do I stop.
 *
 * It also corrects the page around it. A Sync screen that says a workspace
 * "isn't backed up or synced anywhere" is telling the truth about the Atomic
 * side and the wrong thing overall once a mirror is running, so this block says
 * plainly what is mirrored and what that does and does not guarantee.
 */

import type { JSX } from 'react';
import type { Store } from '@tomic/lib';
import { styled } from 'styled-components';
import { ngStatus } from './status.js';
import { useNgBridge } from './useNgBridge.js';

export type NgSyncPanelProps = {
  store: Store;
  /**
   * Where to open the mirrored document.
   *
   * NextGraph's own app routes `#/did:ng:…` to its document view, so a link is
   * just that app's origin plus the nuri. Overridable because a local broker
   * comes with a local wallet app, and pointing at the hosted one then sends
   * people somewhere their wallet is not.
   */
  nextGraphAppUrl?: string;
};

export function NgSyncPanel({
  store,
  nextGraphAppUrl = 'https://nextgraph.eu',
}: NgSyncPanelProps): JSX.Element {
  const {
    enabled,
    setEnabled,
    message,
    graph,
    pending,
    error,
    drive,
    mirrored,
    setMirrored,
    leavesItsHome,
    createWorkspace,
    protection,
    protectWithPasskey,
  } = useNgBridge(store);

  const live = mirrored && error === undefined && graph !== undefined;

  return (
    <Card>
      <Row>
        <Dot $live={live} />
        <Title>{ngStatus('NextGraph')}</Title>
        <State>
          {message}
          {pending > 0 ? ngStatus(' · ') + pending + ngStatus(' pending') : ''}
        </State>
      </Row>

      {/* Describes what is actually happening, not what the feature does in
          general. An earlier version claimed the workspace was mirrored
          whenever the mirror was switched on, which read as a flat lie on a
          workspace it had refused to touch. */}
      <Body>
        {drive === undefined
          ? ngStatus('Open a workspace to mirror it into NextGraph.')
          : mirrored
            ? ngStatus(
                'This workspace is mirrored into a NextGraph document while the app is open. Other NextGraph apps can read and write the same data.',
              )
            : ngStatus(
                'This workspace is not mirrored. Turn it on to let other apps in the suite read and write the same data.',
              )}
      </Body>

      {error !== undefined ? <Problem>{error}</Problem> : null}

      {graph !== undefined ? (
        <Detail>
          <DetailLabel>{ngStatus('Document')}</DetailLabel>
          <Nuri title={graph}>{graph}</Nuri>
          <Open
            href={`${nextGraphAppUrl}/#/${graph}`}
            target='_blank'
            rel='noreferrer noopener'
            title={ngStatus(
              'Opens this document in NextGraph. You need your wallet open there.',
            )}
          >
            {ngStatus('Open in NextGraph')}
          </Open>
        </Detail>
      ) : null}

      {mirrored ? (
        <Note>
          {ngStatus(
            'Sync runs while the app is open. Your workspace stays on this device either way, so it keeps working when NextGraph is unreachable.',
          )}
        </Note>
      ) : null}

      {/* Mirroring a workspace that lives on a server is a disclosure, not a
          backup: the data has a home already, and its administrator may not
          know about the NextGraph document. Worth one sentence before the
          click, rather than a refusal after it. */}
      {!mirrored && drive !== undefined && leavesItsHome ? (
        <Note>
          {ngStatus(
            'This workspace is held on a server. Mirroring copies its data into a NextGraph document you control, so turn it on only for data you may share.',
          )}
        </Note>
      ) : null}

      <Actions>
        {drive !== undefined ? (
          <Button type='button' onClick={() => setMirrored(!mirrored)}>
            {mirrored
              ? ngStatus('Stop mirroring this workspace')
              : ngStatus('Mirror this workspace')}
          </Button>
        ) : (
          <Button type='button' onClick={() => void createWorkspace()}>
            {ngStatus('Create a workspace')}
          </Button>
        )}

        {mirrored && protection === 'local-storage' ? (
          <Button type='button' onClick={() => void protectWithPasskey()}>
            {ngStatus('Protect with a passkey')}
          </Button>
        ) : null}

        {protection === 'passkey' ? (
          <Protected>{ngStatus('Unlocked with a passkey')}</Protected>
        ) : null}
      </Actions>
    </Card>
  );
}

// Theme-free by necessity: this package cannot depend on the host app's theme,
// and `light-dark()` keeps it legible in both without one.
const Card = styled.section`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin: 1rem 0;
  padding: 1.1rem 1.25rem;
  border-radius: 12px;
  border: 1px solid light-dark(rgb(0 0 0 / 10%), rgb(255 255 255 / 14%));
  background: light-dark(#fff, #17181c);
  color: light-dark(#1b1c1f, #e9eaee);
  color-scheme: light dark;
  font: 14px/1.55 system-ui, sans-serif;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 0.55rem;
`;

const Dot = styled.span<{ $live: boolean }>`
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${p => (p.$live ? '#27ae60' : 'light-dark(#b9bdc6, #5b606b)')};
`;

const Title = styled.h3`
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
`;

const State = styled.span`
  margin-left: auto;
  font-size: 0.85rem;
  color: light-dark(#5c626c, #a6abb5);
  font-variant-numeric: tabular-nums;
`;

const Body = styled.p`
  margin: 0;
  color: light-dark(#4b5058, #a6abb5);
`;

const Problem = styled.p`
  margin: 0;
  color: #c0392b;
`;

const Detail = styled.div`
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  min-width: 0;
`;

const DetailLabel = styled.span`
  font-size: 0.8rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: light-dark(#7a808b, #8b909a);
`;

const Nuri = styled.code`
  font: 0.82rem/1.4 ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
`;

const Open = styled.a`
  margin-left: auto;
  white-space: nowrap;
  font-size: 0.85rem;
  color: #3b82f6;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }

  &:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
    border-radius: 3px;
  }
`;

const Note = styled.p`
  margin: 0;
  font-size: 0.85rem;
  color: light-dark(#7a808b, #8b909a);
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.2rem;
`;

const Button = styled.button`
  padding: 0.4rem 0.9rem;
  border-radius: 8px;
  border: 1px solid light-dark(rgb(0 0 0 / 18%), rgb(255 255 255 / 22%));
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;

  &:hover {
    background: light-dark(rgb(0 0 0 / 5%), rgb(255 255 255 / 8%));
  }
`;

const Protected = styled.span`
  font-size: 0.85rem;
  color: light-dark(#5c626c, #a6abb5);
`;
