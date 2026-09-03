/**
 * Turning the NextGraph mirror on, and knowing what it is doing.
 *
 * Off unless asked for: `?ngbridge=1` in the URL, or `atomic.ngBridge` in
 * localStorage. The URL form sets the localStorage flag so it survives a
 * reload, which is what you want while demonstrating it. `?ngbroker=<url>`
 * does the same for the broker's bootstrap URL. Everything heavy
 * (`attachNgBridge`, and through it the NextGraph engine) is behind a dynamic
 * import, so a normal session never loads a byte of it.
 */

import { useCallback, useEffect, useState } from 'react';
import { StoreEvents, type Store } from '@tomic/lib';
import type { NgBridgeHandle } from './attachNgBridge';
import { ngStatus } from './status';
import {
  isMirrored,
  leavesItsHome as computeLeavesItsHome,
  setMirrored as persistMirrored,
} from './mirrorPreference.js';
import {
  passwordSource,
  upgradeToPasskey,
  walletPassword,
  type PasswordSource,
} from './walletPassword.js';

const FLAG_KEY = 'atomic.ngBridge';

/**
 * Same key `ngSession.ts` reads when creating a wallet. Settable from the URL
 * (`?ngbroker=<bootstrap url>`) for the same reason the flag is: a demo
 * against a broker of our own should not begin with a trip to the devtools.
 */
const BOOTSTRAP_URL_KEY = 'atomic.ngBridge.bootstrapUrl';

export type NgBridgeState = {
  enabled: boolean;
  /** The workspace this is about, if one is open. */
  drive?: string;
  /** Whether this workspace mirrors. One choice per workspace. */
  mirrored: boolean;
  /** Turns mirroring on or off for this workspace, now. */
  setMirrored: (mirrored: boolean) => void;
  /**
   * True when mirroring this workspace would send data outward from a server
   * that already holds it, so the choice deserves a warning rather than a
   * default.
   */
  leavesItsHome: boolean;
  /** Creates a fresh mirrored workspace and opens it. */
  createWorkspace: () => Promise<void>;
  /** Turns the mirror on or off now, without a reload. Persists the choice. */
  setEnabled: (enabled: boolean) => void;
  /** What currently protects the wallet password. */
  protection: PasswordSource;
  /**
   * Moves the password into a passkey. Must be called from a user gesture
   * (WebAuthn requires one), which is why it is handed to the UI rather than
   * run automatically.
   */
  protectWithPasskey: () => Promise<void>;
  /** What the bridge is doing, in words fit for a badge. */
  message: string;
  graph?: string;
  pending: number;
  error?: string;
};

function readFlag(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const broker = params.get('ngbroker');

    if (broker) {
      localStorage.setItem(BOOTSTRAP_URL_KEY, broker);
    }

    if (params.get('ngbridge') === '1') {
      localStorage.setItem(FLAG_KEY, '1');

      return true;
    }

    if (params.get('ngbridge') === '0') {
      localStorage.removeItem(FLAG_KEY);

      return false;
    }

    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    // Storage can be unavailable (private mode). Then the bridge is off, which
    // is the safe default.
    return false;
  }
}

function writeFlag(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(FLAG_KEY, '1');
    } else {
      localStorage.removeItem(FLAG_KEY);
    }
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
}

/**
 * Attaches the bridge to the current drive, once, while the drive is
 * local-only. Returns state for the badge.
 */
export function useNgBridge(store: Store): NgBridgeState {
  const [protection, setProtection] = useState<PasswordSource>('none');
  // Bumped to re-run the attach effect after something changes that the effect
  // cannot see, such as a drive becoming local-only under it.
  const [revision, setRevision] = useState(0);
  const [enabled, setEnabledState] = useState(readFlag);
  const [state, setState] = useState<
    Pick<NgBridgeState, 'message' | 'graph' | 'pending' | 'error'>
  >({
    message: ngStatus('Off'),
    pending: 0,
  });

  const setEnabled = useCallback((next: boolean) => {
    writeFlag(next);
    setEnabledState(next);

    if (!next) {
      setState({ message: ngStatus('Off'), pending: 0 });
    }
  }, []);

  useEffect(() => {
    void passwordSource().then(setProtection);
  }, []);

  const protectWithPasskey = useCallback(async () => {
    const result = await upgradeToPasskey();

    setProtection(await passwordSource());

    if (!result.ok) {
      setState(current => ({ ...current, error: result.message }));
    }
  }, []);

  // The drive is not necessarily set when this mounts: `/app/dev-drive` and the
  // demo route both create theirs asynchronously, and the first render happens
  // long before that. Follow the store instead of reading once.
  const [drive, setDrive] = useState<string | undefined>(() => store.getDrive());

  useEffect(
    () => store.on(StoreEvents.DriveChanged, next => setDrive(next)),
    [store],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (drive === undefined) {
      setState(current => ({
        ...current,
        message: ngStatus('No workspace open'),
      }));

      return;
    }

    if (!isMirrored(store, drive)) {
      setState(current => ({
        ...current,
        message: ngStatus('Not mirrored'),
      }));

      return;
    }

    let handle: NgBridgeHandle | undefined;
    let cancelled = false;

    const report = (message: string) =>
      setState(current => ({ ...current, message }));

    (async () => {
      try {
        const { attachNgBridge } = await import('./attachNgBridge');

        handle = await attachNgBridge({
          store,
          drive,
          connection: {
            kind: 'public-broker',
            password: await walletPassword(),
          },
          onStatus: report,
        });

        if (cancelled) {
          await handle.stop();

          return;
        }

        setState({
          message: ngStatus('Live'),
          graph: handle.graph,
          pending: 0,
        });

        // The bridge reports through its status object rather than events, so
        // poll it for the badge. Cheap, and it keeps the bridge free of UI
        // concerns.
        const timer = setInterval(() => {
          const status = handle?.bridge.status;

          if (status === undefined) {
            return;
          }

          setState(current => ({
            ...current,
            pending: status.pending,
            error:
              status.lastError === undefined
                ? undefined
                : [
                    status.lastError.direction,
                    (status.lastError.error as Error).message ??
                      ngStatus('failed'),
                  ].join(ngStatus(': ')),
          }));
        }, 1000);

        return () => clearInterval(timer);
      } catch (error) {
        // The mirror is optional. A failure here is worth reporting in the
        // badge, and worth nothing more: the app's own data is untouched.
        setState(current => ({
          ...current,
          message:
            error instanceof Error && error.name === 'NgMirrorUnavailableError'
              ? ngStatus('Not connected')
              : ngStatus('Failed'),
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();

    return () => {
      cancelled = true;
      void handle?.stop();
    };
    // Re-attaching on a drive switch is correct: each drive mirrors into its own
    // NextGraph document, and the cleanup above stops the previous bridge before
    // the next one starts.
  }, [store, drive, enabled, revision]);

  const mirrored = drive !== undefined && isMirrored(store, drive);
  const leavesItsHome =
    drive !== undefined && computeLeavesItsHome(store, drive);

  const setMirrored = useCallback(
    (next: boolean) => {
      if (drive === undefined) {
        return;
      }

      persistMirrored(drive, next);

      if (!next) {
        setState({ message: ngStatus('Not mirrored'), pending: 0 });
      }

      // The choice is not something the attach effect can observe on its own.
      setRevision(value => value + 1);
    },
    [drive],
  );

  const createWorkspace = useCallback(async () => {
    const { ensureWorkspace } = await import('./signIn.js');
    const created = await ensureWorkspace(store);
    setRevision(value => value + 1);
    history.pushState({}, '', `/app/show?subject=${encodeURIComponent(created)}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [store]);

  return {
    ...state,
    enabled,
    setEnabled,
    drive,
    mirrored,
    setMirrored,
    leavesItsHome,
    createWorkspace,
    protection,
    protectWithPasskey,
  };
}
