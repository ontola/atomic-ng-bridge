# NextGraph integration notes

Running log of every limitation, bug, missing capability and undocumented behavior found in
NextGraph while building this bridge. **Kept current as work proceeds**: anything that costs us time,
surprises us, or turns out to be undocumented gets an entry here the same day, whether or not it
blocked us in the end.

**This document tracks, it does not fix.** Nothing here is a task. When something in this list
blocks us, the workaround lives on our side and the entry records it. What is worth sending
upstream is collected separately, in `docs/upstream-findings.md`.

This is written to be readable by someone outside this repo, including upstream. Every claim is
either something we read in NextGraph's own source (cited) or something we observed ourselves
(described). Where we were wrong earlier, the correction is in the entry rather than in a silent
edit.

## At a glance

| # | What | Status | Costs us |
| --- | --- | --- | --- |
| A1 | Web SDK forces the app inside the wallet's iframe | Verified | Rejected that path (PLAN §4) |
| A2 | No credential handoff in the web SDK | Verified | Rules out worker-based sync on that path |
| A3 | The non-iframe wrapper (`api-web`) is unpublished | Verified | We reimplemented it |
| A4 | Published packages are mutually skewed; skew fails silently | Verified | Boot probe + a CI check |
| A5 | No headless session in the browser | Verified | No service-identity writer client-side |
| A6 | Published wasm is a bundler target, and 8.1 MB | Verified | 3 MB gzipped before first data |
| A7 | All storage goes through `postMessage`; hangs silently without a host handler | Verified | ~1h lost; we ship the handler |
| A8 | `wallet_create` already opens the wallet and starts a session | Verified | Undocumented; the obvious sequence fails |
| A9 | `user_connect` panics on the user id that `wallet_create` returns | Verified | Wasm panic instead of a type error |
| A10 | The published typings are `any` almost everywhere | Verified | We maintain our own typed slice |
| A11 | The wallet's third-party storage has no JS write path (`wallet_update` is `unimplemented!()`) | Verified | We derive the Atomic key instead of storing it |
| B1 | No durable local store in the browser; durability needs a broker | Verified | A broker is a hard dependency of the NextGraph side |
| B2 | No peer-to-peer transport at all | Verified | Every sync is broker-routed |
| B3 | Public broker refuses an unregistered wallet, reporting only "Closing" | Verified | Sync needs a broker of our own, or a registered account |
| B4 | Reopening a session: three undocumented steps, and stores arrive asynchronously | Verified | Remember the document nuri instead of rediscovering it at startup |
| B5 | A broker's admin invitation is single use, and says so only as a protocol error | Verified | Use `/.ng_bootstrap` instead |
| C1 | `doc_create` rejects arbitrary class names | Reported (upstream) | Class lives in the RDF instead |
| C2 | Multi-operation SPARQL updates | **Answered: they work** | One commit per edit, not two |
| C3 | RDF has no ordering; Atomic arrays do | Verified (inherent) | One bookkeeping triple per subject |
| C4 | ORM had no filters, ordering or paging; alpha.21 adds equality filters, sorting and pages | Superseded in part | Constrains NextGraph-native UI less than it did |
| C5 | ORM has no date type | Reported | Dates lose their type for ORM consumers |
| D1 | The iframe architecture defeats browser automation | Reported | Argues for the embedded engine |
| D2 | Wallet auth page shows "Invalid request" on reload | Reported | Minor, costs debugging time |
| D3 | The broker does not build on macOS; upstream's own container build skips it | Verified | Built under linux/amd64 in a container instead |

Sections E and F record things that are **not** problems: assumptions we had to correct (E), and
undocumented behavior we now depend on deliberately (F1-F4) — recorded because an upstream change to
any of it breaks us silently.

## How to add an entry

Every entry needs: what the problem is, **evidence** (file path, version, or an observation we
made ourselves), the impact on this project, any workaround we chose, a status, and a date.

Status vocabulary, used strictly:

- **Verified**: read in NextGraph's own source, or observed directly by us. Cite the file or the
  observation.
- **Reported**: recorded by someone else, or an upstream code comment says so. Plausible, not
  independently confirmed by us.
- **Unverified**: we believe this may be true and it matters, but nobody here has checked.
  Do not repeat these as fact outside this repo.

Versions this was built against: `@ng-org/lib-wasm` 0.1.2-alpha.6, `@ng-org/web` 0.1.2-alpha.13,
`@ng-org/orm` 0.1.2-alpha.19, `@ng-org/shex-orm` 0.1.2-alpha.8. Rechecked against npm before
sharing: `lib-wasm` unchanged at alpha.6, `web` alpha.14, `orm` alpha.21. Entries affected by the
newer versions say so.

---

## A. SDK and packaging

### A1. The web SDK forces the whole app to live inside the wallet's iframe

**Status:** Verified.
**Evidence:** `nextgraph-rs/sdk/js/web/src/index.ts`. `init()` begins with
`window.location.href = <wallet redirect>` when the app is top-level. Every subsequent API call
goes through `parent.postMessage(...)` to the wallet's origin; the exported `ng` object is an
async proxy over that channel and nothing else.
**Impact:** Using `@ng-org/web` means the application is permanently a guest inside a hosted
wallet page. We do not control our own top-level document, and the hosted wallet becomes a
required runtime dependency of the product.
**Workaround:** Do not use `@ng-org/web`. Drive `@ng-org/lib-wasm` directly. See PLAN.md section 4.

### A2. No credential handoff exists in the web SDK

**Status:** Verified.
**Evidence:** Same file. There is no API that yields a session token, key, or handle the app can
pass anywhere. The wallet holds credentials; the app holds a message port.
**Impact:** Any design that assumes "the main thread completes auth, then hands credentials to a
worker or a background context" is not implementable on this path. This is a design constraint,
not a missing convenience.

### A3. The non-iframe wrapper is not published

**Status:** Verified.
**Evidence:** `nextgraph-rs/sdk/js/api-web/package.json` is `private: true`. Confirmed absent from
the npm registry.
**Impact:** `api-web` is the thin proxy over the wasm that NextGraph's own wallet app uses, which
is exactly the layer a third-party app driving the engine itself would want. Because it is
unpublished, that path is undocumented and unsupported for outside consumers: you either build
NextGraph from source or reimplement the wrapper. We reimplement it.
**Note:** `@ng-org/lib-wasm` itself *is* published, which is what makes the embedded-engine route
viable at all.

### A4. Published packages are mutually skewed, and skew fails silently

**Status:** Verified for the version numbers. Reported for the failure mode.
**Evidence:** Published versions when this was built were `lib-wasm` alpha.6, `web` alpha.13, `orm`
alpha.19; at the recheck, alpha.6, alpha.14 and alpha.21, with `lib-wasm` the one that has not moved. A
previously observed failure in `../elfa-tables`: a pinned `@ng-org/orm` called WASM methods
`orm_start` / `orm_update` that the deployed wallet had renamed to `orm_start_graph` /
`graph_orm_update`. Nothing threw. Reads returned empty and writes never committed.
**Impact:** This is the nastiest class of problem on this list, because the symptom is "the app
works and the data quietly is not there." Version compatibility between a client and whichever
broker or wallet it targets is not expressed anywhere machine-checkable.
**Workaround:** Pin every `@ng-org/*` version explicitly and record them in PLAN.md section 10.
Add a startup probe that asserts every wasm method we depend on actually exists, so skew fails
loudly at boot instead of silently at read time.

### A5. Headless sessions are unavailable in the browser

**Status:** Verified.
**Evidence:** `sdk/js/lib-wasm/src/lib.rs`. `session_headless_start` and `session_headless_stop`
are behind `#[cfg(wasmpack_target = "nodejs")]`.
**Impact:** In a browser there is no session mode that runs without wallet-derived user context.
A background, service-identity-shaped writer is not available client-side. Browser code gets
`session_start` (persistent) or `session_in_memory_start`, both of which are the user's session.

### A6. The published wasm is a bundler target, and it is 8 MB

**Status:** Verified.
**Evidence:** `@ng-org/lib-wasm@0.1.2-alpha.6`'s entry is
`import * as wasm from "./lib_wasm_bg.wasm"` followed by `wasm.__wbindgen_start()` at module
scope, i.e. wasm-pack's *bundler* target. There is no `init()` to call and no ESM-friendly
fallback. Built through Vite in `apps/spike`, the emitted artifact is
`lib_wasm_bg.wasm`, **8,126 kB** (3,034 kB gzipped).
**Impact:** Two things. First, packaging: a consumer needs `vite-plugin-wasm` (plus an `esnext`
target so top-level await compiles), which is fine for us but is undocumented for anyone adopting
the SDK outside NextGraph's own build. Second, weight: 3 MB gzipped of engine before a single row
of the user's data. That is a real cost of the embedded-engine decision and it lands on first load.
**Workaround:** `apps/spike/vite.config.ts` carries the working configuration. The size has no
workaround; it is a number to state honestly rather than discover in a demo.

### A7. The wasm delegates all storage to the host page over postMessage, and hangs silently without it

**Status:** Verified. Found by running it.
**Evidence:** `@ng-org/lib-wasm@0.1.2-alpha.6`'s
`snippets/lib-wasm-*/jsland/browser.js` never touches `localStorage`. Every storage operation is
`postMessage({method:"local_get", key, port}, {transfer:[port]})` onto the current context, with the
answer expected back on a transferred `MessagePort`. The methods are `local_get`, `local_save`,
`session_get`, `session_save`, `session_remove` and `storage_clear`. The local broker's lazy init
(`INIT_LOCAL_BROKER` in `sdk/js/lib-wasm/src/lib.rs:1010`) wires these as its `JsStorageConfig`, and
every SDK entry point begins with `init_local_broker_with_lazy`.
**Impact:** With no handler installed, the very first SDK call — *any* call — never settles. Observed
directly: `get_wallets()` hung past 10s with zero CPU, zero network and no console output; nothing
rejects, nothing times out, nothing is logged. Undocumented: the only implementation is in the
unpublished `api-web` (`sdk/js/api-web/main.ts:44-95`), which runs the wasm in a Worker and answers
these messages from the main thread. A consumer of the *published* package has to reverse-engineer
this from the snippet source.
**Workaround:** `packages/ng-engine/src/storage-bridge.ts` implements the handler, matching
`api-web`'s semantics (which methods reply, which are fire-and-forget), for the wasm on the main
thread and, via a relayed `MessagePort`, for the wasm in a worker. After installing it,
`get_wallets()` returned in **5 ms**.

### A8. `wallet_create` already opens the wallet and starts a session

**Status:** Verified.
**Evidence:** `wallet_create_v0` (`sdk/rust/src/local_broker.rs:1642`) inserts the new wallet into
the broker, calls `wallet_was_opened`, and calls `session_start`, all before returning. Its result
type carries `session_id`, `user`, `wallet_name` and `wallet`
(`engine/wallet/src/types.rs:1354-1391`). Doing what the wallet app's *login* flow does afterwards —
`wallet_import`, then `session_start` — fails with `WalletAlreadyAdded`, which is what we hit.
**Impact:** The obvious sequence (create, import, open, start a session) is wrong, and the error
names a symptom rather than the cause. Nothing documents that create is a complete login.
**Workaround:** After `wallet_create`, use the returned `session_id` directly.

### A9. `user_connect` panics on the user id that `wallet_create` hands you

**Status:** Verified.
**Evidence:** `wallet_create`'s result carries `user` as a serialized `PubKey` **object**
(`{"Ed25519PubKey":[142,4,…]}`), while `user_connect(client_info, user_id: String, location)`
(`sdk/js/lib-wasm/src/lib.rs:2269`) calls `decode_key` on a *string*. Passing the object aborts the
wasm with `memory access out of bounds` — observed directly in the spike.
**Impact:** A type mismatch between two adjacent calls in the same SDK surfaces as a wasm memory
error, not a rejected promise with a message. Anyone hitting it will look for a bug in their own
code first, as we did.
**Workaround:** Call `session_start` / `session_in_memory_start` on the already-started session; its
result gives `user` in string form (and the `private_store_id`).

### A10. The published typings are `any` almost everywhere

**Status:** Verified.
**Evidence:** `@ng-org/lib-wasm@0.1.2-alpha.6`'s `lib_wasm.d.ts`: `sparql_query(session_id: any,
sparql: string, base: any, nuri: any): Promise<any>`, `wallet_create(params: any): Promise<any>`,
`session_start(wallet_name: string, user_id: any): Promise<any>`, and so on. Argument shapes
(`CreateWalletV0`, session results, SPARQL results) exist only in the Rust types and in the Svelte
app that calls them.
**Impact:** No compile-time protection against exactly the class of error in A8 and A9, and no
discoverability: the only way to learn a parameter shape is to read `nextgraph-rs`. It is also why
a version bump that changes a shape cannot fail a typecheck.
**Workaround:** `packages/ng-engine/src/wasm.ts` declares the slice of the SDK we call, and the
argument shapes we depend on, in one place.

### A11. The wallet's third-party storage cannot be written from JavaScript

**Status:** Verified.
**Evidence:** `SensitiveWalletV0.third_parties: HashMap<String, ByteBuf>` exists and is documented as
*"third parties data saved in the wallet… the format of the byte array (value) is up to the vendor"*
(`engine/wallet/src/types.rs:471`). It has first-class wallet operations, `AddThirdPartyDataV0` and
`RemoveThirdPartyDataV0` (`:960`), and the engine applies them (`:811`). The only JS entry point,
`wallet_update`, deserializes both arguments and then calls **`unimplemented!()`**
(`sdk/js/lib-wasm/src/lib.rs:272`) — so calling it from a browser aborts the wasm rather than
failing with an error.
**Impact:** This is the natural place for another system to keep a secret that should travel with
the user's wallet — for us, the Atomic signing key, so a user manages one secret instead of two.
The feature is designed, typed and applied; it is only the door from JavaScript that is missing.
**Workaround:** Derive instead of store. `packages/ng-engine/src/identity.ts` runs HKDF-SHA256 over
the opened wallet's own key material, domain-separated and salted with the wallet id, to produce
the Atomic private key. Same wallet, same identity, on every device, nothing extra to back up.
If `wallet_update` is ever implemented, storing the key should replace derivation, and the derived
key becomes the migration path for wallets created before that.
**Worth reporting upstream:** this is a small gap (the operation and its application already exist)
with a large payoff for anyone integrating another system with a NextGraph wallet.

---

## B. Runtime and platform constraints

### B1. In a browser there is no durable local store; durability requires a broker

**Status:** Verified in NextGraph's source; confirmed by running it (B4).
**Evidence:** All in `../nextgraph-rs`:
- `engine/verifier/src/types.rs:191` — `VerifierType::Save`: "will save all user data locally, with
  RocksDb backend on native, and on webapp, will save only the session and wallet, **not the data
  itself**."
- `sdk/rust/src/local_broker.rs:1057` — in a browser (`LocalBrokerConfig::JsStorage`),
  `VerifierType::Save` maps to `VerifierConfigType::JsSaveSession`, whose own doc comment is "only
  the session information is saved locally. the UserStorage is not saved."
- `engine/verifier/src/verifier.rs:2770` — for `Memory | JsSaveSession` the verifier is built with a
  fresh in-memory oxigraph `Store::new()` and an `InMemoryUserStorage`.
- `engine/verifier/src/verifier.rs:542` — `load()` (which repopulates stores and repos from local
  storage) is gated on `is_persistent()`, and `types.rs:281` makes that true only for `RocksDb`. In
  a browser it never runs.
- `engine/verifier/src/types.rs:197` and `:272` — `WebRocksDb`, the IndexedDB-backed persistent
  store, is "not ready yet. obviously."
**Impact:** Large. A browser app driving NextGraph has no durable local graph: it lives in memory
for the lifetime of the page. Data survives a reload only because a broker accepted it and serves it
back. The broker is therefore a hard runtime dependency for durability, not a sync accelerator. That
is the difference between "no server in the loop" and "a server we do not run is in the loop," and
the second is the accurate description.
**Note:** The session, the wallet and the outbox *are* persisted in the browser
(`JsSaveSessionConfig` carries `last_seq`, `outbox_write` and `outbox_read` functions,
`local_broker.rs:100`), so unsent events survive a reload. The graph does not.
**Consequence for us:** an argument for the mirror rather than against it — Atomic's own OPFS store
is the durable local copy, and the app keeps working with the broker unreachable.

### B2. No peer-to-peer transport: every sync goes through a broker

**Status:** Verified.
**Evidence:** A case-insensitive grep over every `.rs` file in `../nextgraph-rs` returns **zero**
matches for `stun`, `upnp`, `hole punch`, `nat traversal` and `webrtc`. Transport is WebSocket to a
broker (`sdk/rust/src/local_broker.rs:2556`, `server.get_ws_url(...)`), and direct connections are an
explicit unimplemented TODO at `local_broker.rs:2562` ("deal with all Box -> direct connections"),
scoped there to tauri/CLI rather than the browser.
**Impact:** Two devices on the same network cannot sync without routing through a broker. Together
with B1, there is no browser configuration in which NextGraph works without one.

### B3. The public broker refuses an unregistered wallet, and says so only as "Closing"

**Status:** Verified.
**Evidence:** A wallet created against `nextgraph.eu`'s published bootstrap
(`https://nextgraph.eu/.ng_bootstrap`, which is exactly what an invitation decodes to) starts a
session fine, but `user_connect` returns
`{server_ip: "wss://nextgraph.eu", error: "Closing"}` — the broker accepts the socket and closes it.
The bootstrap document itself names `registration_url: https://account.nextgraph.eu/#/create`, so
registration is presumably the missing step; the SDK surfaces this as a one-word connection error
rather than anything actionable.
**Impact:** Local engine operation is unaffected (documents create, writes apply, queries read back
— all verified). What is blocked is sync and therefore durability, per B1. It also means "create a
wallet and start syncing" is not self-service against a public broker.
**Note on the error:** `Closing` is indistinguishable from an ordinary disconnect. An app has no way
to tell a user "your account is not registered with this broker" from what the SDK reports.

### B4. Reopening a session in the browser: three undocumented steps, and stores arrive asynchronously

**Status:** Verified end to end: a triple written into a document before a reload was
read back after it, from the same document, in a new session, with the data coming from the broker.
Cross-session persistence works. Getting there took three findings, each of which independently
produces the same `RepoNotFound`, so together they make the platform look as if it does not:

1. **`wallet_read_file` is not a parser.** It refuses a wallet the local broker already holds, with
   `WalletAlreadyAdded` (`sdk/rust/src/local_broker.rs:2172`). That is the *normal* state for a
   returning user, because the local broker restores its wallet list from `localStorage['ng_wallets']`
   at init (`local_broker.rs:1513`). A returning user must be opened with `get_wallets()` plus
   `wallet_open_with_password`, never from the saved file. Treating the error as a broken wallet and
   creating a new one silently forks the user's identity on every reload.
2. **`get_wallets()` returns a JS `Map`, not an object.** It serializes a Rust `HashMap` through
   `serde_wasm_bindgen`, so `Object.keys(...)` on the result finds nothing and the caller concludes
   the browser holds no wallet. The published typings say `any` (A10), so nothing catches it.
3. **`user_connect` needs the string user id, not the wallet's `personal_site`.** This is A9 again,
   on the reopen path: `session_start` takes the `PubKey` object, and returns
   `SessionInfoString.user` (`engine/wallet/src/types.rs:135`), which is what `user_connect` wants.
   Handed the object, the connection never opens, and with no broker connection there is nothing
   to restore stores *from*, which is what produces the `RepoNotFound`.

**What the platform does, for the record.** `connection_opened` calls `bootstrap()`, which calls
`bootstrap_from_remote()` and falls back to flushing the outbox
(`engine/verifier/src/verifier.rs:1992` and `:1247`). So recovery runs automatically when a broker
connection opens. It is asynchronous, which matters for the next point.

**The one real usage constraint.** Stores arrive *after* the connection opens, so a discovery query
run at startup ("find the document with my app's class triple") returns nothing for the first
seconds of a session. Treating that empty answer as "no document exists" makes the app create a
second document beside the real one. Observed: five reloads, five orphan documents, each holding
nothing but its own class triple. The fix is to remember the document nuri and reopen it by name,
waiting while it reports `RepoNotFound`, rather than rediscovering it
(`packages/ui/src/documentMemory.ts`, `findOrCreateDocument`'s `knownNuri`).

**Impact:** none on durability once known. The cost is that `RepoNotFound` is reported identically
for "no broker connection", "not restored yet" and "this wallet genuinely has no such repo", so each
of the three above looks like a platform limit rather than a usage error.

**Worth asking upstream:** whether `wallet_read_file` could either be renamed or return the held
wallet instead of an error, and whether `get_wallets` could return a plain object.

### B5. The admin invitation a broker prints is single use

**Status:** Verified.
**Evidence:** `ngd` prints "The admin invitation link is: …" at startup. Creating one wallet with
it works. A second attempt is rejected: the broker logs `get_invitation_type`, replies
`AuthResult(result: 11)`, and closes the socket with `ProtocolError(NotFound)`.
**Impact:** Minor once known, confusing before: the failure names neither the invitation nor its
having been spent. Use the broker's `/.ng_bootstrap` instead, which is reusable and, with
`--registration-open`, needs no invitation at all.

---

## C. Data model and API

### C1. `doc_create` does not accept arbitrary class names

**Status:** Reported by upstream.
**Evidence:** `sdk/js/examples/expense-tracker-discrete/src/utils/loadStore.ts`, in NextGraph's own
example: the `class_name` argument is passed as `"data:json"` or `"data:map"` with the comment
"Currently, the class name cannot be arbitrary due to a bu[g] in the ng interface."
**Impact:** Document classification has to happen in the RDF content instead. The example itself
works around this by writing `<doc> a <ApplicationClass>` as a triple after creation, then finding
the document later with a SPARQL query over the union graph. We do the same.

### C2. Multi-operation SPARQL updates — ANSWERED: they work

**Status:** Verified against a real document via `apps/spike`.
**Evidence:** `sparql_update(session_id, sparql, nuri)` with a scoped `DELETE ... WHERE` and an
`INSERT DATA` joined by `;` was accepted and applied. Spike log: `=> C2 ANSWERED: ;-separated updates
ARE accepted. One commit per edit.`
**Impact:** Good news, and it removes a real cost: a mirrored resource update is **one** commit with
no transient empty state, not two commits with a window where the subject has no properties.
**Consequence:** `preserveForeignPredicates` aside, the pusher now defaults
`supportsMultiOperationUpdate` to true (PLAN.md section 6).

### C3. RDF has no ordering, and Atomic arrays do

**Status:** Verified, inherent to the model rather than a NextGraph defect. Logged here because it
is a real cost of the target format and will keep coming up.
**Impact:** `resourceArray` order cannot be expressed by plain triples. `rdf:List` is well-formed
but awkward to query and to update incrementally.
**Workaround:** Emit plain member triples for native consumers plus one bookkeeping triple per
subject carrying the order. See PLAN.md section 5.

---

### C4. The ORM could only scope by graph and subject; alpha.21 adds filters, ordering and pages

**Status:** Verified for alpha.19. Superseded in part by alpha.21.
**Evidence, alpha.19:** `dist/types.d.ts:15`. `Scope` was `{graphs?, subjects?}` and nothing more;
`useShape(shape, scope)` materialized the whole matching set into memory.
**Evidence, alpha.21:** `dist/utilTypes.d.ts:52`, `RdfOrmConfig` extends
`Scope` with `where` (equality on a literal, one of a list, or a nested shape's properties),
`orderBy` (asc/desc on one or more string, number or boolean properties), and `pageSize` plus
`maxActivePages` for windowed pagination, which requires `orderBy`.
**What is still missing, as of alpha.21:** range filters (a `where` value is an equality or a
membership test, so "amount between 10 and 100" or "date after" cannot be pushed down), and any
aggregation. `sparql_query` remains the escape hatch and is still not the live-subscription path.
**Impact:** Smaller than first recorded. A table over the ORM can now sort, page and filter by
equality on the engine's side; numeric and date range filters and aggregates still run client-side
over whatever is loaded. Atomic's own table pushes all of those down
(`../atomic-server/browser/data-browser/src/chunks/TablePage/useTableData.ts`).
**Impact on this repo:** none directly, since the bridge maps generic triples and does not use the
ORM. Logged because it constrains any NextGraph-native UI built over the mirrored data.

### C5. The ORM has no date type

**Status:** Reported from prior work in `../elfa-tables`. Still the case in alpha.21: `valType` is one of
`boolean`, `iri`, `number`, `set`, `shape`, `string`.
**Evidence:** `../elfa-tables/README.md`, gotchas: `date` fields are declared `valType: "string"`
because the ORM has no dedicated date type.
**Impact:** Date columns lose their type for ORM consumers. The bridge is unaffected, it writes
`xsd:date` / `xsd:dateTime` literals directly (PLAN.md section 5), so the datatype lives in the RDF
itself where any SPARQL consumer can see it.

---

## D. Developer experience

### D1. The iframe architecture defeats browser automation

**Status:** Reported from prior work in `../elfa-tables`.
**Evidence:** `elfa-tables/README.md`, "Automation note". With the app running inside the wallet's
cross-origin iframe, headless Chromium does not paint out-of-process iframes into screenshots and
does not expose their DOM or accessibility tree to automation. The app's real runtime errors appear
only in the iframe's own console, not the top page's.
**Impact:** End-to-end testing and agent-driven debugging are close to impossible on the iframe
path. Verification has to happen by hand in a headed browser.
**Note:** This is one of the practical reasons the embedded-engine route is worth its cost: our own
top-level document is testable normally.

### D2. Wallet auth page shows "Invalid request" on reload

**Status:** Reported from prior work in `../elfa-tables`.
**Evidence:** `elfa-tables/README.md`. Hard-reloading the wallet auth page itself, rather than the
app, produces "Invalid request". It is the auth page's error state for a stale or consumed request,
not an application bug.
**Impact:** Minor, but it costs time every time someone new hits it and starts debugging their own
app.

---

### D3. The broker does not build on macOS, and upstream's own container build skips it

**Status:** Verified.
**Evidence:** `cargo build -p ngd` in `../nextgraph-rs` fails in `ng-rocksdb`'s build script:
`Unable to find libclang: "couldn't find any valid shared libraries matching: ['libclang.dylib']
... (invalid: [])"`. Tried with `LIBCLANG_PATH` pointing at `llvm@17`'s lib directory, at the
dylib itself, at Xcode's command line tools, and via `cargo --config env.LIBCLANG_PATH`; the error
is byte-identical each time, including the empty `invalid: []`, i.e. the build script sees no
candidates at all regardless of what it is told. `DEV.md` says only "install llvm@17" (which is
installed, and whose `libclang.dylib` is a valid arm64 Mach-O). Upstream's own
`bin/ngd/docker/Dockerfile.alpine` has the `cargo build -p ngd` lines **commented out**, with the
comment `# From here the build fails due to llvm / clang linking issues...`.
**Impact:** Without a broker of one's own there is nothing to test durability against (B1, B3), and
a contributor wanting one is blocked on a build upstream knows is broken.
**Workaround:** build it in a Linux container. Two further obstacles on the way,
both worth reporting: the vendored `ng-rocksdb` passes `-march=haswell` unconditionally, so the
build dies on ARM and must run as `linux/amd64`; and a `ngd` built without the bundled web app
**panics** on any plain `GET /` from a loopback client (`App::get("index.sha256").unwrap()`,
`engine/broker/src/server_ws.rs:252`), which is startling the first time a health check hits it.
With those handled, `cargo build -p ngd` finishes in about 6 minutes and the broker runs fine.

## E. Explicitly not problems

Recorded so they do not get raised again.

### E1. Shapes do not have to be compiled ahead of time

Runtime-constructed shape objects work. A `ShapeType` is a plain object of `{ schema, shape }` and
the ORM reads only those fields, so a shape can be built in JavaScript at runtime with no codegen
step. Demonstrated in `../elfa-tables` (`src/table/defineShape.ts`). This matters because
"NextGraph needs shapes declared ahead of time, so dynamic schema editing is impossible" has been
assumed before and is not correct.

Separately: this bridge does not depend on it either way, because it maps generic triples rather
than shapes. See PLAN.md section 5.

### E2. Atomic Data does not need a translation vocabulary

Atomic Data is a type-safe subset of RDF, and Atomic properties and classes are ordinary
dereferenceable resources with real URIs. Atomic property URIs are used directly as RDF predicates.
There is no parallel vocabulary to maintain and no semantic translation layer.

---

## F. Undocumented behavior we rely on

Not defects: things that work, that we depend on, and that are written down nowhere except
NextGraph's own source. Recorded because an upstream change to any of them breaks us silently, and
because the next person should not have to rediscover them.

### F1. A broker publishes its bootstrap at `/.ng_bootstrap`

`https://nextgraph.eu/.ng_bootstrap` returns
`{"V0":{"bootstrap":{"servers":[…]},"registration_url":"…"}}`, and `V0.bootstrap` is exactly what
`decode_invitation` produces from an invitation link. So `wallet_create` can be given a broker
directly, with no invitation: this is how `apps/spike` creates a wallet unattended. Verified
by fetching it and creating a wallet with it. CORS allows a browser to read it.

### F2. The wallet -> session -> document sequence exists only in the Svelte app

There is no written specification of how to go from a wallet file to a usable session. The sequence
we implement in `packages/ng-engine/src/session.ts` was read off
`nextgraph-rs/app/ui-common/src/routes/WalletLogin.svelte`, `lib/Login.svelte` and
`routes/WalletCreate.svelte`: `wallet_read_file` -> `wallet_open_with_password` -> `wallet_import`
(first time on a device) or `wallet_was_opened` -> `session_start` -> `user_connect`. Create is
different again, see A8.

### F3. A document's RDF lives in a named graph whose IRI is the document nuri

Writes are `INSERT DATA { GRAPH <did:ng:o:…> { … } }` passed to `sparql_update(session_id, sparql,
nuri)`; `sparql_query` with `nuri` undefined queries the union of the user's documents, which is how
a document is found by class. Read from `sdk/js/lib-wasm/src/lib.rs` and
`sdk/js/examples/expense-tracker-discrete/src/utils/loadStore.ts`, and confirmed by our own
round trip through a real document.

### F4. `sparql_query` returns standard SPARQL 1.1 JSON

`{results: {bindings: [{var: {type: "uri"|"literal"|"bnode", value, datatype?, "xml:lang"?}}]}}`.
Not stated anywhere in the package; confirmed against real results in `apps/spike`. Our parser
(`packages/ng-engine/src/results.ts`) depends on this shape.
