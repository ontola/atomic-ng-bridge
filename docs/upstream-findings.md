# Notes from integrating with the NextGraph SDK

**Draft. Not sent. Intended for the NextGraph team.**

Hello,

We have built a working integration between Atomic Data and NextGraph: an Atomic app running
entirely client side, with its data mirrored live into a NextGraph document as ordinary RDF, and
NextGraph-side writes flowing back. It runs against the published `@ng-org/lib-wasm` (0.1.2-alpha.6)
and a real broker.

Along the way we kept a log of everything that cost us time, surprised us, or turned out to be
undocumented. We are sending it because most of it is cheap to fix and would save the next
integrator the same days it cost us, and because two items are small gaps with a large payoff for
anyone building on the SDK.

Everything below was read in your source or observed directly by us, with citations. Where we were
wrong at first, the correction is included rather than quietly dropped. Nothing here is a complaint
about the design, which we like; it is about the seams a third party hits first.

---

## 1. The storage contract is undocumented, and its absence hangs silently

**This one cost us most, and is probably a one-page fix in the README.**

`@ng-org/lib-wasm` does not touch `localStorage` itself. Every storage operation is
`postMessage({method: "local_get", key, port}, {transfer: [port]})` onto the current context, with
the answer expected back on the transferred `MessagePort`. The methods are `local_get`,
`local_save`, `session_get`, `session_save`, `session_remove` and `storage_clear`
(`snippets/lib-wasm-*/jsland/browser.js`). The local broker's lazy init wires these as its
`JsStorageConfig` (`sdk/js/lib-wasm/src/lib.rs:1010`), and every SDK entry point begins with
`init_local_broker_with_lazy`.

If the host page does not answer those messages, the **first** SDK call never returns. Any call.
We observed `get_wallets()` hang past ten seconds with zero CPU, zero network traffic and nothing
logged. There is no error, no rejection and no timeout, so it is indistinguishable from a bug in
your own code, which is where we looked first.

The only implementation of the handler is in `sdk/js/api-web/main.ts:44-95`, which is
`private: true` and unpublished. A consumer of the published package has to reverse engineer it
from the snippet source.

**Suggested fix, in order of cost:** a paragraph in the `lib-wasm` README describing the contract;
or publishing `api-web`; or having the SDK fall back to `localStorage` directly when no handler
answers within a short window.

## 2. `wallet_update` is unimplemented, which blocks third parties from using the wallet's own extension point

`SensitiveWalletV0.third_parties` is documented as "third parties data saved in the wallet ... the
format of the byte array (value) is up to the vendor" (`engine/wallet/src/types.rs:471`). There are
first-class operations for it, `AddThirdPartyDataV0` and `RemoveThirdPartyDataV0` (`:960`), and the
engine applies them (`:811`).

The only JavaScript entry point, `wallet_update`, deserializes both arguments and then calls
`unimplemented!()` (`sdk/js/lib-wasm/src/lib.rs:272`), so calling it from a browser aborts the wasm.

**Why this matters to us specifically:** we need a stable Atomic signing key per user. The wallet's
third-party slot is exactly the right home for it: encrypted with the wallet, travelling with wallet
export, QR pairing and the recovery kit. Since we cannot write it, we derive the key from the
wallet instead (HKDF, domain separated, salted with the wallet id). That works, and we are happy
with it, but it has one consequence we cannot engineer around: a user who **already has** an Atomic
identity cannot fold it into their wallet. They must start a new one.

**This is our main ask.** The operation, its application and its type all exist. Only the door from
JavaScript is missing.

## 3. Two API contracts that surprise, one of which aborts the wasm

- `wallet_create` already adds the wallet, opens it and starts a session before it returns
  (`wallet_create_v0`, `sdk/rust/src/local_broker.rs:1642`). Following it with the login flow's
  `wallet_import` fails with `WalletAlreadyAdded`. Nothing says create is a complete login, and the
  error names a symptom rather than the cause.
- The `user` that `wallet_create` returns is a serialized `PubKey` object, while `user_connect`
  takes the string form (`sdk/js/lib-wasm/src/lib.rs:2269`). Passing the object aborts the wasm with
  `memory access out of bounds`. A type mismatch between two adjacent calls in the same SDK
  surfacing as a memory error is a rough first hour for an integrator.

Both would be solved by the typings below.

## 4. The published typings are effectively untyped

`lib_wasm.d.ts` gives `sparql_query(session_id: any, sparql: string, base: any, nuri: any):
Promise<any>`, `wallet_create(params: any): Promise<any>`, and so on. The real shapes
(`CreateWalletV0`, session results, SPARQL results) exist only in the Rust types and in the Svelte
app that calls them.

Consequences: no compile-time protection against exactly the mismatches in item 3; no
discoverability without reading `nextgraph-rs`; and a version bump that changes a shape cannot fail
a typecheck. We maintain our own typed slice of the surface we call, which is duplicated work that
`wasm-bindgen` could largely emit.

## 5. Version skew between published packages fails silently

Published versions are currently `lib-wasm` alpha.6, `web` alpha.13, `orm` alpha.19. A previous
project of ours pinned an `@ng-org/orm` that called `orm_start` / `orm_update` against a wallet
whose wasm had renamed them to `orm_start_graph` / `graph_orm_update`. Nothing threw. Reads returned
empty and writes never committed.

Silent divergence is the worst failure mode a data layer can have. Even a version constant the
client can compare against the broker at connect time would turn this into a loud error. We now
probe at boot that every method we call exists, which catches renames but not signature changes.

## 6. The broker does not build, and your own container build says so

`cargo build -p ngd` fails in `ng-rocksdb`'s build script with
`Unable to find libclang ... (invalid: [])`. We tried `LIBCLANG_PATH` pointed at `llvm@17`, at the
dylib itself, at Xcode's command line tools, and through `cargo --config env.LIBCLANG_PATH`; the
error is byte-identical every time, including the empty candidate list. `DEV.md` says only to
install llvm@17, which we had.

`bin/ngd/docker/Dockerfile.alpine` has the `cargo build -p ngd` lines commented out, with
`# From here the build fails due to llvm / clang linking issues...`.

The practical effect is that a contributor cannot run a private broker to test against, which
matters more than it sounds given the next item.

## 7. Browser durability: ANSWERED, and three sharp edges that hid the answer

**This section used to be a question, and the most important one on the list. It is now a set of
findings, because the answer turned out to be "it works".**

Persistence across browser sessions works. Verified against our own `ngd`: a triple written into a
document before a page reload, read back after it, from the same document, in a new session, with
the data coming from the broker. `connection_opened` calls `bootstrap()` →`bootstrap_from_remote()`
(`engine/verifier/src/verifier.rs:1247` and `:1992`), which is exactly the recovery we could not
find and told ourselves did not exist.

We had concluded the opposite, and we were wrong. Three API behaviours produced an identical
`RepoNotFound` and led us there. Each is small; together they cost us a day and a retracted claim.

1. **`wallet_read_file` refuses a wallet the local broker already holds**, with `WalletAlreadyAdded`
   (`sdk/rust/src/local_broker.rs:2172`). That is the normal state for a returning user, because the
   broker restores its wallet list from `localStorage['ng_wallets']` at init (`:1513`). The name
   reads like a parser, so we used it as the entry point for reopening a saved wallet, and treated
   its error as a broken wallet. The result was a **new wallet, and therefore a new identity, on
   every page load** — the single most destructive thing our integration did, and it looked like a
   NextGraph limitation rather than our bug. Could this either return the held wallet, or be named
   for what it does?
2. **`get_wallets()` returns a JavaScript `Map`, not an object.** It serializes a Rust `HashMap`
   through `serde_wasm_bindgen`. `Object.keys(wallets)` on the result is empty, so a caller checking
   for an existing wallet concludes there is none. With the typings as they are (section 4), nothing
   catches this. A plain object would be friendlier, and a typed return would make it moot.
3. **`user_connect` needs `SessionInfoString.user`, not the wallet's `personal_site`.** This is the
   type mismatch from section 3, on a second path. `session_start` takes the `PubKey` object and
   returns the string; `user_connect` wants the string. Given the object, the connection silently
   does not open — and since store recovery happens *on connection*, every later document call fails
   with `RepoNotFound`, which points the integrator at documents rather than at the connection.

**The one thing we would still ask you to document:** the restore is asynchronous. A document
discovery query run right after `user_connect` returns nothing, because the user's repos have not
arrived yet. An application that reads that as "no document exists" creates a second document beside
the real one; we did that five times before we understood it. A sentence in the docs, or a way to
await bootstrap completion, would save the next integrator the same fork.

## 7b. What a rejected wallet looks like

We would like to understand the intended state here rather than assume it.

In a browser, `VerifierType::Save` is documented as saving "on webapp ... only the session and
wallet, not the data itself" (`engine/verifier/src/types.rs:191`). A browser session maps to
`JsSaveSession`, built with an in-memory oxigraph store and `InMemoryUserStorage`
(`sdk/rust/src/local_broker.rs:1057`, `engine/verifier/src/verifier.rs:2770`), and `load()` is gated
on a persistence flag that is false there (`verifier.rs:542`). `WebRocksDb` is marked "not ready
yet" (`types.rs:197`). So data written by a browser app survives a reload because a broker accepted
it and sends it back, which is consistent with what we now observe.

Separately, a wallet created against the public broker's published bootstrap
(`https://nextgraph.eu/.ng_bootstrap`) connects and is then closed: `user_connect` returns
`{server_ip: "wss://nextgraph.eu", error: "Closing"}`. We assume this is registration, and that is
reasonable. The point worth raising is that `Closing` is indistinguishable from an ordinary
disconnect, so an application cannot tell a user "your account is not registered with this broker"
from what the SDK reports. Given how much of section 7 came down to a connection that was not open,
a distinct signal here would be worth a lot.

**Questions:** is `WebRocksDb` on the roadmap, and is there an intended pattern for a browser app
that wants to work offline before it has ever reached a broker? And could a rejected registration
be reported distinctly from a dropped connection?

## 8. Smaller notes

- The published wasm is a wasm-pack *bundler* target: its entry imports the `.wasm` directly and
  calls `__wbindgen_start()` at module scope. Consumers need `vite-plugin-wasm` plus an `esnext`
  target, which is undocumented. The artifact is 8.1 MB (3.0 MB gzipped), which is worth stating
  somewhere a consumer will see before they measure it themselves.
- The ORM's `where`, `orderBy` and `pageSize` in alpha.21 cover most of what a table needs; what
  is left is range filters (a `where` value is an equality or a list) and aggregation, which a
  table over numbers and dates pushes down to the engine. This is feedback rather than a defect,
  and it is the remaining reason we map plain triples and use `sparql_query` rather than the ORM.
- `doc_create` not accepting arbitrary class names is already noted in your own example
  (`sdk/js/examples/expense-tracker-discrete/src/utils/loadStore.ts`), and the workaround there,
  writing the class as a triple, works well.

---

## Things that worked, worth saying

- `sparql_update` accepts several `;` separated operations in one call, which lets a scoped delete
  and insert land as a single commit. We had assumed we would need two.
- Shapes do not have to be compiled ahead of time. A `ShapeType` is a plain `{schema, shape}` object
  and the ORM reads only those fields, so shapes can be built at runtime. We have seen the opposite
  assumed in discussions about dynamic schemas, and it is not true.
- The document model, an RDF named graph whose IRI is the document nuri, mapped onto our data
  cleanly and without special cases.
- `/.ng_bootstrap` being published means an app can be pointed at a broker without an invitation
  link, which made unattended testing possible.

## What we would ask for, in priority order

1. `wallet_update` implemented, so third parties can use the wallet's own extension point.
2. The storage contract documented, or `api-web` published.
3. The three sharp edges in section 7, in the order given there. None is hard, and between them they
   cost us a day and a public claim we had to withdraw.
4. A build path for `ngd` that works: it needs a Linux container today, the vendored rocksdb assumes
   x86 (`-march=haswell` breaks ARM), and a broker built without the bundled web app panics on a
   plain `GET /` from a loopback client (`server_ws.rs:252`). None of these is hard to fix, and
   together they make "run your own broker" harder than it should be. Also worth a line in the
   README: the admin invitation a broker prints is single use.

Happy to turn any of the above into issues or patches if that is more useful than a letter.
