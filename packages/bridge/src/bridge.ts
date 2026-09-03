/**
 * The bridge: both directions, one lifecycle, one cursor store.
 *
 * Everything below this is separately testable and separately replaceable; this
 * is the object an application actually holds. It exists so that an app does
 * not have to know that echo suppression is a shared-cursor trick, or that pull
 * has to run once at startup before push is allowed to overwrite anything.
 */

import { createPuller, type AtomicSink, type PullResult } from './pull.js';
import { createPusher, type FlushResult, type PusherOptions } from './push.js';
import type { AtomicSource, CursorStore, NgTransport } from './ports.js';
import type { MappingWarning } from './types.js';

export type BridgeStatus = {
  running: boolean;
  /** Subjects queued for push. */
  pending: number;
  /** Last error from either direction, if any. */
  lastError?: { direction: 'push' | 'pull'; subject: string; error: unknown };
  /** Set once the initial pull has completed. */
  initialPullDone: boolean;
};

export type BridgeOptions = {
  /** The NextGraph document this drive mirrors into. */
  graph: string;
  source: AtomicSource;
  sink: AtomicSink;
  transport: NgTransport;
  cursors: CursorStore;
  /** See `PusherOptions`. */
  push?: Pick<
    PusherOptions,
    'supportsMultiOperationUpdate' | 'emitRdfType' | 'preserveForeignPredicates' | 'debounceMs'
  >;
  shouldPull?: (subject: string) => boolean;
  onWarning?: (warning: MappingWarning) => void;
  onStatus?: (status: BridgeStatus) => void;
};

export type Bridge = {
  /**
   * Pulls once, then starts both directions.
   *
   * The order is not incidental. Starting push first would let a local resource
   * overwrite a NextGraph-side change made while the app was closed, because
   * push has no cursor for it yet and would treat it as new. Pulling first
   * establishes what NextGraph already holds.
   */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Pushes anything queued now. */
  flush: () => Promise<FlushResult>;
  /** Re-reads the whole document. */
  pullAll: () => Promise<PullResult>;
  readonly status: BridgeStatus;
};

export function createBridge(options: BridgeOptions): Bridge {
  const {
    graph,
    source,
    sink,
    transport,
    cursors,
    push = {},
    shouldPull,
    onWarning,
    onStatus,
  } = options;

  let stopPush: (() => void) | undefined;
  let stopPull: (() => void) | undefined;
  let initialPullDone = false;
  let lastError: BridgeStatus['lastError'];

  const status = (): BridgeStatus => ({
    running: stopPush !== undefined,
    pending: pusher.pending,
    lastError,
    initialPullDone,
  });

  const report = () => onStatus?.(status());

  const pusher = createPusher({
    graph,
    source,
    transport,
    cursors,
    onWarning,
    onError: error => {
      lastError = { direction: 'push', ...error };
      report();
    },
    ...push,
  });

  const puller = createPuller({
    graph,
    sink,
    transport,
    cursors,
    shouldPull,
    onWarning,
    onError: error => {
      lastError = { direction: 'pull', ...error };
      report();
    },
  });

  return {
    start: async () => {
      await puller.pullAll();
      initialPullDone = true;

      stopPush = pusher.start();
      stopPull = await puller.start();
      report();
    },

    stop: async () => {
      stopPush?.();
      stopPull?.();
      stopPush = undefined;
      stopPull = undefined;
      await transport.close();
      report();
    },

    flush: async () => {
      const result = await pusher.flush();
      report();

      return result;
    },

    pullAll: async () => {
      const result = await puller.pullAll();
      report();

      return result;
    },

    get status() {
      return status();
    },
  };
}
