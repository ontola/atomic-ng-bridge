/**
 * The storage bridge the wasm requires, and that nothing documents.
 *
 * `@ng-org/lib-wasm` does not touch `localStorage` itself. Every storage
 * operation is a `postMessage({method, key, port})` onto the current context,
 * with the answer expected back on a transferred `MessagePort`. If nobody
 * answers, the promise never settles: the local broker's lazy init awaits a
 * `local_get` that hangs, so the *first* call into the SDK — any call, including
 * `get_wallets()` — hangs forever with no error, no rejection and no timeout.
 *
 * NextGraph's own unpublished `api-web` implements this handler on the main
 * thread while running the wasm in a Worker (`sdk/js/api-web/main.ts`). We run
 * the wasm on the main thread, so the same messages arrive at `window` and we
 * answer them here. The semantics below match that file exactly, including
 * which methods reply and which are fire-and-forget.
 *
 * See `NEXTGRAPH-ISSUES.md` A7.
 */

export type StorageBridgeOptions = {
  /**
   * Where the wasm's storage messages arrive.
   *
   * `window` when the engine runs in the page. A `Worker` when it runs in one:
   * a bare `postMessage` from inside a worker goes to the page, which is where
   * storage actually lives, so the page listens on the worker object.
   */
  target?: Window | Worker;
  /** Defaults to `localStorage`. */
  local?: Storage;
  /** Defaults to `sessionStorage`. */
  session?: Storage;
  /** Called for every serviced message. Useful when proving the wiring works. */
  onCall?: (method: string, key?: string) => void;
};

type StorageMessage = {
  method?: string;
  key?: string;
  value?: string;
  port?: MessagePort;
};

/**
 * Installs the handler. Call it **before** the first SDK call, and keep the
 * returned function to uninstall it.
 */
export function installNgStorageBridge(
  options: StorageBridgeOptions = {},
): () => void {
  // Resolved lazily rather than in the parameter defaults: a worker client can
  // legitimately be constructed where `window` does not exist (tests, and any
  // non-DOM host), and touching it eagerly would fail before the caller's own
  // `target` was even considered.
  const globals = globalThis as unknown as {
    window?: Window;
    localStorage?: Storage;
    sessionStorage?: Storage;
  };
  const target = options.target ?? (globals.window as Window | Worker);
  const local = options.local ?? (globals.localStorage as Storage);
  const session = options.session ?? (globals.sessionStorage as Storage);
  const { onCall } = options;

  if (target === undefined) {
    throw new Error(
      'installNgStorageBridge needs a target: a Window, or the Worker running the engine.',
    );
  }

  const reply = (port: MessagePort | undefined, message: unknown) => {
    port?.postMessage(message);
    port?.close();
  };

  const handler = (event: MessageEvent) => {
    const data = event.data as StorageMessage | undefined;
    const method = data?.method;

    if (data === undefined || method === undefined) {
      return;
    }

    switch (method) {
      case 'local_get':
      case 'session_get': {
        const store = method === 'local_get' ? local : session;

        try {
          // `getItem` returns null for a missing key, which is what the wasm
          // expects; it distinguishes "absent" from an error reply.
          reply(data.port, { ok: store.getItem(data.key ?? '') });
        } catch (error) {
          reply(data.port, { error: (error as Error).message });
        }

        break;
      }

      case 'local_save':
      case 'session_save': {
        const store = method === 'local_save' ? local : session;

        try {
          store.setItem(data.key ?? '', data.value ?? '');
          reply(data.port, { ok: true });
        } catch (error) {
          reply(data.port, { error: (error as Error).message });
        }

        break;
      }

      case 'session_remove': {
        // Fire and forget: the wasm sends no port for this one.
        try {
          session.removeItem(data.key ?? '');
        } catch {
          // Storage can be unavailable (private mode, blocked cookies). The
          // wasm is not waiting on an answer, so there is nothing to report.
        }

        break;
      }

      case 'storage_clear': {
        try {
          local.clear();
          session.clear();
        } catch {
          // Same as above.
        }

        break;
      }

      default:
        return; // Not ours: the page may use postMessage for other things.
    }

    onCall?.(method, data.key);
  };

  target.addEventListener('message', handler as EventListener);

  return () => target.removeEventListener('message', handler as EventListener);
}
