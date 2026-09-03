/**
 * The slice of `@ng-org/lib-wasm` this package uses.
 *
 * The published typings are almost entirely `any` (`session_id: any`,
 * `Promise<any>`), so declaring the shape we depend on here is the only place
 * the contract is written down. It also gives the boot probe something concrete
 * to check against.
 */

/** SPARQL 1.1 JSON results, as `sparql_query` returns them. */
export type SparqlBindingTerm =
  | { type: 'uri'; value: string }
  | { type: 'bnode'; value: string }
  | {
      type: 'literal';
      value: string;
      datatype?: string;
      'xml:lang'?: string;
    };

export type SparqlResults = {
  head?: { vars?: string[] };
  results?: { bindings?: Record<string, SparqlBindingTerm>[] };
};

export type NgWasm = {
  wallet_create: (params: unknown) => Promise<unknown>;
  decode_invitation: (invite: string) => Promise<unknown>;
  wallet_open_with_password: (wallet: unknown, password: string) => unknown;
  wallet_was_opened: (openedWallet: unknown) => Promise<unknown>;
  wallet_read_file: (file: Uint8Array) => Promise<unknown>;
  wallet_get_file: (walletName: string) => Promise<unknown>;
  wallet_import: (
    encryptedWallet: unknown,
    openedWallet: unknown,
    inMemory: boolean,
  ) => Promise<unknown>;
  get_wallets: () => Promise<unknown>;
  /** Re-reads the wallets the local broker persisted, e.g. after a reload. */
  wallets_reload: () => Promise<unknown>;
  session_start: (walletName: string, userId: unknown) => Promise<unknown>;
  session_in_memory_start: (
    walletName: string,
    userId: unknown,
  ) => Promise<unknown>;
  user_connect: (
    clientInfo: unknown,
    userId: string,
    location?: string | null,
  ) => Promise<unknown>;
  client_info: () => unknown;
  doc_create: (
    sessionId: unknown,
    crdt: string,
    className: string,
    destination: string,
    storeRepo: unknown,
  ) => Promise<string>;
  doc_subscribe: (
    repoO: string,
    sessionId: unknown,
    callback: (...args: unknown[]) => void,
  ) => Promise<unknown>;
  sparql_query: (
    sessionId: unknown,
    sparql: string,
    base: unknown,
    nuri: unknown,
  ) => Promise<SparqlResults | boolean | unknown>;
  sparql_update: (
    sessionId: unknown,
    sparql: string,
    nuri: unknown,
  ) => Promise<unknown>;
};

/**
 * Every wasm function this package calls. Kept as data so the boot probe and
 * the type above cannot drift apart silently.
 */
export const REQUIRED_WASM_METHODS: (keyof NgWasm)[] = [
  'wallet_create',
  'decode_invitation',
  'wallet_read_file',
  'wallet_get_file',
  'wallet_open_with_password',
  'wallet_was_opened',
  'wallet_import',
  'get_wallets',
  'wallets_reload',
  'session_start',
  'session_in_memory_start',
  'user_connect',
  'client_info',
  'doc_create',
  'doc_subscribe',
  'sparql_query',
  'sparql_update',
];

export class WasmSkewError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `The loaded NextGraph wasm is missing ${missing.length} method(s) this build calls: ${missing.join(
        ', ',
      )}. This is version skew between @ng-org/lib-wasm and this app (see NEXTGRAPH-ISSUES.md A4).`,
    );
    this.name = 'WasmSkewError';
  }
}

/**
 * Fails loudly at boot if the wasm does not export what we call.
 *
 * Worth the twelve lines: the documented skew failure is silent
 * (`NEXTGRAPH-ISSUES.md` A4). An `@ng-org/orm` pinned against a renamed method
 * returned empty reads and dropped every write, with nothing thrown. A missing
 * method should stop the app, not quietly cost the user their data.
 */
export function probeWasmMethods(
  module: Partial<Record<keyof NgWasm, unknown>>,
  required: readonly (keyof NgWasm)[] = REQUIRED_WASM_METHODS,
): void {
  const missing = required.filter(name => typeof module[name] !== 'function');

  if (missing.length > 0) {
    throw new WasmSkewError(missing as string[]);
  }
}
