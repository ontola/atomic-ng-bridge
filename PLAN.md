# atomic-ng-bridge: plan

Status: implemented through M6; the milestone list below records what is done and what is open.

This document is the entry point for the work. It records the goal, the architecture, every
decision and the reason behind it, what was verified against real code before any of it was
written, and what is still genuinely unknown.

NextGraph limitations, bugs and undocumented behavior found along the way are tracked separately, in
`NEXTGRAPH-ISSUES.md`, and that log is kept current as work proceeds: anything that costs us time,
surprises us, or turns out to be undocumented gets an entry the same day, whether or not it ended up
blocking us. It is a log, not a task list.

---

## 1. Goal

Ship one integrated, client-side database app (tables, forms, kanban, calendar, card views,
comments) whose data lives continuously in NextGraph, with no AtomicServer instance anywhere in
the architecture.

Three requirements, in priority order:

1. **The app has to be genuinely good.** Not a demo, not a widget: the polished, keyboard-driven,
   live-collaborative table and form experience, with runtime schema editing, version history and
   undo/redo intact.
2. **No AtomicServer dependency.** Nothing hosted, nothing to deploy, nothing to point a domain
   at, nothing that goes down. Sharing a survey over plain HTTP is the one deliberate exception,
   and it is opt-in and out of scope here.
3. **NextGraph is where the data durably lives.** Changes flow into NextGraph as they happen and
   NextGraph-side changes flow back, so anything else built on NextGraph can read and write the
   same data natively.

## 2. Non-goals

- No changes to `@tomic/lib`'s core. No `Backend` abstraction, no making `Resource` Loro-optional.
  The sync layer is new, additive, separable code that uses each side's existing public surface.
  This is the whole point of the approach: the product every other consumer of the library relies
  on is not put at risk to get this.
- No background sync while the app is closed. Sync runs while the app is open. That is an accepted
  scope decision, not a workaround: the app must be open to be used at all.
- No hosted gateway, no REST bridge, no webhook service. Those need a running server process and
  are a separate, later, opt-in conversation.
- No rewrite of the table/form/kanban components. They ship as they are.

---

## 3. What was verified against real code first

Everything in this section was checked directly in `../atomic-server`, `../nextgraph-rs` and the
published npm registry, not inferred. Several of these findings changed the design.

### 3.1 The Atomic side already runs fully client-side

This is not a roadmap item. It exists and works today:

- **Local-only drives are a first-class concept.** `Store.registerLocalOnlyDrive(subject)`
  (`browser/lib/src/store.ts`) marks a drive as never-POSTed and never enrolled in the outbox.
  Resources under it save, chain commits and materialize history entirely client-side.
  `browser/lib/src/local-only-drive.test.ts` asserts exactly this.
- **A working no-account path exists.** `browser/data-browser/src/chunks/Demo/guestAgent.ts` mints
  a throwaway `did:ad:agent:` keypair, persists it to IndexedDB, and registers it local-only.
  `demoWorkspace.ts` then builds a complete workspace (tables, boards, chatrooms) against it. So
  "open the app, get a real working database, no signup, no server" is already a shipping path.
- **Persistence is OPFS, owned by a dedicated worker.** `browser/lib/src/client-db.ts` implements
  leader-owns-DB with `navigator.locks` plus `BroadcastChannel` fanout to follower tabs. The
  leader spawns a plain `DedicatedWorker` because `createSyncAccessHandle` is not available in
  `SharedWorker` on Firefox or Safari. This is settled, working plumbing we do not touch.
- **The CRDT lives in the library, not the server.** Loro is a peer dependency of `@tomic/lib`.
  That is why runtime schema editing, ordered arrays with real CRDT insert semantics, and version
  history and undo/redo all keep working with no server present. None of those are server
  features.
- **Client-side full-text search exists.** `browser/lib/src/local-search.ts` is a MiniSearch index,
  partitioned per drive, and `Store.search()` falls back to it automatically when no server is
  connected. This corrects an assumption worth stating precisely, because it was previously
  believed search was simply lost without a server:
  - What works client-side: prefix and fuzzy full-text search over `name`, `description` and
    `shortname`, scoped to a drive, with parent-chain scoping.
  - What does not: property-value filters and facets (those go through the server's Tantivy
    index), and indexing of body content beyond those three fields.
  - So the honest claim is "full-text search over titles and descriptions works with no server;
    filtered and faceted search does not," rather than "no search."
- **Webhooks genuinely are lost.** They fire off the server's own commit pipeline. There is no
  client-side equivalent and we are not inventing one.

### 3.2 The NextGraph side: two very different attachment paths

This is where research changed the plan.

**`@ng-org/web` cannot be used the way a background sync layer needs.** Reading
`../nextgraph-rs/sdk/js/web/src/index.ts` directly:

- `init()` starts by doing `window.location.href = <wallet redirect>` at top level. It requires a
  real `window`.
- Every single API call goes through `parent.postMessage(...)` to the wallet's origin. The exported
  `ng` object is an async proxy over that channel, nothing more.
- Consequence one: the app must run **inside the hosted wallet's iframe**, permanently. The wallet
  frames us, not the other way around.
- Consequence two: this cannot run in a Worker of any kind. A worker has no `window` and no
  `parent`. There is also no credential handoff to give a worker, because the app never holds
  credentials in this model: the wallet does.

**`@ng-org/lib-wasm` is published and exports everything needed.** Verified against the npm
registry and by unpacking the tarball (`0.1.2-alpha.6`):

- Exported and relevant: `wallet_create`, `wallet_open_with_password`, `wallet_open_with_mnemonic`,
  `session_start`, `session_in_memory_start`, `session_stop`, `user_connect`, `sparql_query`,
  `sparql_update`, `doc_create`, `doc_subscribe`, `branch_history`, `update_header`,
  `orm_start_graph`, `graph_orm_update`, `gen_wallet_for_test`.
- `@ng-org/api-web`, the thin proxy the NextGraph wallet app itself uses over this wasm, is marked
  `private: true` and is **not** published. It is a small wrapper; we reimplement its equivalent.
- `session_start` maps to `SessionConfig::new_save` (persistent) and `session_in_memory_start` to
  `new_in_memory`. `session_headless_start` is gated to the nodejs wasm target and is not
  available in a browser.

**The NextGraph data model, as it actually works.** From `sdk/js/lib-wasm/src/lib.rs` and the usage
in `app/ui-common/src/store.ts` and `sdk/js/examples/expense-tracker-discrete`:

- A document is a repo, addressed by a nuri of the form `did:ng:<docId>`, optionally suffixed with
  an overlay (`did:ng:<docId>:<overlay>`).
- Its RDF content is a **named graph whose IRI is the document nuri**. Writes look like
  `INSERT DATA { GRAPH <did:ng:...> { ... } }` passed to `sparql_update(session_id, sparql, nuri)`.
- `sparql_query(session_id, sparql, base, nuri)` with `nuri` undefined queries the union of the
  user's documents, which is how you find an existing document by class.
- `doc_create(session_id, crdt, class_name, destination, store_repo)` returns the new document id.

**Version skew is a known, real hazard.** An earlier prototype lost writes silently because a
pinned `@ng-org/orm` called WASM methods (`orm_start` / `orm_update`) that the deployed wallet had
renamed (`orm_start_graph` / `graph_orm_update`). Nothing errored; reads simply returned nothing.
Note that the published `lib-wasm` (alpha.6) currently lags the published `web` (alpha.13) and
`orm` (alpha.19) packages, which is exactly the shape of that hazard.

---

## 4. Architecture decision: embedded engine, no iframe

**We run the NextGraph engine ourselves, in our own app, by importing `@ng-org/lib-wasm`
directly.** No hosted wallet UI, no top-level redirect, no iframe.

Rejected alternative: the `@ng-org/web` iframe path. It is lower technical risk and has been
proven end to end before, but it makes our entire application a guest inside a hosted wallet's
frame, permanently, and it forecloses ever moving sync off the main thread. Given that requirement
2 is "no dependency on anyone's hosted service," attaching via a permanently-required hosted wallet
frame contradicts the thing we are trying to deliver.

What the decision costs, stated plainly:

- We take on the ~50 lines that `api-web` would have given us, plus wasm loading and lifecycle.
- We handle wallet material in the user's own browser. This is a real change to the trust story:
  the app opens the user's wallet locally rather than delegating that to a hosted wallet page. It
  is the user's own device, but it is our code touching their keys, and it deserves a written
  security note before it ships.
- We are pinned to the published `lib-wasm`, which is alpha and lags its siblings. If we ever need
  to talk to a broker running a newer protocol, skew is our problem to manage.

Mitigation for both: everything above the engine talks to a narrow `NgTransport` interface (four
methods: query, update, subscribe, close). The engine is one implementation behind that seam. If
the embedded path turns out to be blocked, swapping in an iframe-backed transport is a contained
change and does not touch the mapping or the sync logic.

### Layers

```
  app (tables / forms / kanban UI, from the existing component layer)
    |
    |  reads and writes normally, knows nothing about NextGraph
    v
  @tomic/lib Store  ->  dedicated worker  ->  OPFS        [unchanged, authoritative for the app]
    |
    |  StoreEvents.ResourceUpdated / ResourceSaved
    v
  @tomic/ng-bridge          push: Atomic resource -> RDF triples -> SPARQL
                            pull: SPARQL results -> Atomic resource -> ordinary local commit
    |
    v
  NgTransport  (query / update / subscribe / close)
    |
    v
  @tomic/ng-engine  ->  @ng-org/lib-wasm  ->  NextGraph document (named graph)
```

The honest structural description: this is a **mirror**, not a single shared store. Two systems,
each committing its own write, reconciled after the fact, rather than one CRDT both sides operate
on directly. For turn-taking use (someone edits, a collaborator picks it up moments later) this is
not observable. For genuinely simultaneous edits to the same field from both sides inside one sync
window, last-write-wins at the field level applies. We should say this rather than imply a shared
CRDT.

---

## 5. The data mapping

Atomic Data is already valid RDF, a type-safe subset of it, and Atomic properties and classes are
themselves ordinary dereferenceable resources with real URIs. That is what makes a faithful mapping
possible without inventing a parallel vocabulary. Every Atomic property URI is used directly as
the RDF predicate.

**Deliberate design choice: generic triples, not ShEx shapes.** An earlier prototype mapped a
typed shape onto the ORM. We do not do that here. The bridge maps arbitrary Atomic resources to
plain triples, so it is schema-agnostic by construction, which is exactly what keeps runtime
schema editing working: adding a column is just another triple, not a shape recompile. Native
NextGraph consumers can still put a ShEx shape or the ORM over the same triples if they want typed
access.

### Subjects

Atomic subjects are already IRIs (`did:ad:...` for local drives, or `https://...`). They stay
verbatim as RDF subjects inside the NextGraph graph. IRIs are opaque; there is no need to remint
them, and keeping them makes round-tripping exact.

### Datatypes

| Atomic datatype | RDF object |
| --- | --- |
| `string`, `slug`, `markdown` | literal, `xsd:string` |
| `integer` | literal, `xsd:integer` |
| `float` | literal, `xsd:double` |
| `boolean` | literal, `xsd:boolean` |
| `date` | literal, `xsd:date` |
| `timestamp` (ms since epoch) | literal, `xsd:dateTime`, ISO 8601 with milliseconds (lossless) |
| `uri` | literal, `xsd:anyURI` |
| `atomicURL` | IRI |
| `resourceArray` | one IRI object per member, plus order bookkeeping (below) |
| `json` | literal, `rdf:JSON` |
| `localizedText` | one language-tagged literal per BCP 47 tag (the natural RDF mapping) |
| `lorodoc` | literal, base64, bridge-specific datatype. Opaque to native consumers, but round-trips |

`string` / `slug` / `markdown` all land on `xsd:string`, and `atomicURL` versus `uri` is the only
other ambiguity. Both are resolved on the way back by reading the **property's own declared
datatype**, which is authoritative and which the bridge also mirrors into NextGraph. No per-value
type bookkeeping is needed. A literal-datatype-based fallback covers the case where the property
resource has not been loaded yet.

### Ordered arrays

RDF has no order and `resourceArray` does. Rather than force `rdf:List` (well-formed but painful
to query and to update incrementally), the bridge writes both:

1. Plain `<subject> <property> <member>` triples, so native NextGraph consumers see real,
   queryable triples.
2. One bookkeeping triple per subject carrying a JSON map of `{ propertyIri: [orderedMemberIris] }`,
   so the bridge restores exact order on the way back.

One extra triple per subject, no predicate explosion, lossless round trip, and nothing a native
consumer has to understand in order to read the data.

### rdf:type

Atomic's `isA` is emitted both as itself and as `rdf:type`. Native NextGraph queries in the wild
look like `?s a <Class>`, and making that work costs one derived triple. On the way back,
`rdf:type` is ignored as derived.

### Schema

Property and class resources are mirrored like any other resource. That is what makes the
predicates in the mirrored graph dereferenceable, which is what an RDF predicate is supposed to be.

---

## 6. Sync semantics

### Push (Atomic to NextGraph)

Subscribe to `StoreEvents.ResourceUpdated` and `ResourceSaved`. For each changed subject: read its
prop/vals, map to triples, and issue a scoped replace:

```sparql
DELETE { GRAPH <g> { <s> ?p ?o } } WHERE { GRAPH <g> { <s> ?p ?o } };
INSERT DATA { GRAPH <g> { <s> <p> <o> . ... } }
```

Scoped to the one subject, so it cannot touch anything else in the graph. Whether NextGraph's
engine accepts two `;`-separated operations in a single `sparql_update` is unverified and is on
the M0 checklist. If it does not, the same thing runs as two sequential updates, at the cost of two
commits and a transient empty state for that subject.

### Pull (NextGraph to Atomic)

Subscribe to the mirrored document via `doc_subscribe`. On change, query the affected subjects,
map triples back to prop/vals, and write them through Atomic's **ordinary commit path**
(`resource.set(...)` then `resource.save()`), signed by the bridge's own agent.

This deliberately avoids forging commits. Because the target is a local-only drive, `save()`
persists locally and never POSTs. It is a genuine, ordinary local commit, so history, undo and
every subscriber in the app behave normally with no special-casing.

### Cursor and idempotence

The bridge needs durable state that nothing in `@tomic/lib` currently tracks: "what have I already
pushed." This lives in IndexedDB, keyed per drive, and records the last pushed commit per subject.
It must be idempotent against actual pushes, so a worker or tab killed mid-push resumes without
duplicating or skipping. This is real, bounded new engineering.

### Echo suppression

Push and pull will feed each other unless a change is attributable. Every write the bridge makes
into Atomic is tagged with the bridge agent and the NextGraph revision it came from, and the push
side skips anything whose latest commit is the bridge's own. Symmetrically, the pull side ignores
NextGraph revisions the push side just wrote. Getting this wrong produces an infinite loop, so it
gets explicit tests before anything else is built on top of it.

### Identity

Two open items, both flagged rather than assumed:

- **Which identity signs NextGraph writes.** In the embedded-engine model the app has the user's
  own session, so writes are the user's, not a separate service identity. That is arguably better
  (no custody question, no shared service key) but it is a different model from a bridge process
  with its own service identity, and it should be described accurately.
- **Unified login.** A NextGraph wallet logging the user into the app directly, with the Atomic
  device-level agent derived or kept invisible underneath, is the goal. The derivation mechanism
  has not been designed against either codebase yet. Treat it as a direction, not a feature.
  Note also that the two permission models differ in kind: NextGraph is capability-based (holding
  the key is the permission) and Atomic is agent identity plus explicit per-resource rights.
  Mapping one onto the other cleanly is a genuine design question.

---

## 7. Repo layout

```
packages/
  bridge/        @tomic/ng-bridge        mapping + both sync directions + the bridge object.
                                         Pure and transport-agnostic: no wasm, no DOM, no
                                         @tomic/lib at bundle time. Runs in vitest.
                 @tomic/ng-bridge/atomic  the two @tomic/lib adapters (source + sink), behind
                                         their own entry point so the core stays dependency-free.
  ng-engine/     @tomic/ng-engine        NgTransport over @ng-org/lib-wasm: the typed slice of the
                                         SDK, the boot probe, the storage bridge the wasm requires,
                                         wallet/session/document bootstrap, wallet-derived identity.
                                         Replaces the unpublished api-web.
  ui/            @tomic/ng-bridge-react  the whole thing as one React component: sign-in, the
                                         mirror, the status badge, passkey unlock. This is all a
                                         host app imports.
apps/
  spike/                                 M0 harness: drives the engine from a plain tab.
e2e/                                     the demo as a Playwright test, with video.
```

The host app carries no NextGraph code of its own. In `../atomic-server` (branch `feat/ng-bridge`)
the entire footprint is one dependency and `<NgBridgeBadge store={store} />` — see M4.

---

## 8. Milestones

Each has an exit criterion that is a fact, not a feeling.

State: **M0** answered in full, durability included · **M1** mapping done ·
**M2** push done · **M3** pull done · **M3.5** one bridge object done · **M4** running inside the
real app · **M5** wallet-derived identity, passkey unlock and wallet-first sign-in done ·
**M5c** polish open · **M6** worker engine built, not yet wired.
A partner can try this now, against a broker of their own or ours.

**M0. Prove the engine. RUN. ANSWERED IN FULL, durability included.** A plain browser tab, no iframe, no hosted wallet page: load
`@ng-org/lib-wasm`, create or open a wallet, start a session, `sparql_update` a triple into a
document, reload the page, `sparql_query` it back.
- Exit: the data comes back after a reload, **and** we have recorded whether a broker connection
  was required for that to happen. Per `NEXTGRAPH-ISSUES.md` B1 the expected answer is that it does
  not come back without one, so test the broker-unreachable case explicitly: that is the state the
  app has to degrade gracefully into, and it is the one the mirror is supposed to survive.
- Still first. The durability answer is now known from source, but "we can drive the engine at all
  from a plain tab, with no wallet page" is not, and everything downstream depends on it.
- Also answers, on the way: does `sparql_update` accept `;`-separated operations.
- **Built and verified as far as a machine can take it.** `apps/spike` is a plain Vite page (no
  iframe, no hosted wallet) that opens a `.ngw` wallet file in memory, starts a session, creates or
  finds its document, writes, reads back, round-trips a mapped Atomic resource through a real
  NextGraph document, and probes the `;`-separated update question. `pnpm -C apps/spike build`
  succeeds, so the published wasm does load and link through an ordinary bundler pipeline, and the
  boot probe (`packages/ng-engine`) confirms every wasm method we call exists in alpha.6.
- **Run end to end in a real browser**, driven headlessly (D1's automation problem is
  specific to the wallet's cross-origin iframe; our own top-level document automates normally).
  What actually happened, in order:
  - the 8.1 MB wasm initialized in a plain tab, and the boot probe found all 13 methods;
  - the first SDK call then **hung forever** — no CPU, no network, no error. Cause: the wasm
    delegates every storage operation to the host page over `postMessage` and waits for an answer
    nobody was giving. This is undocumented and only implemented in the unpublished `api-web`. With
    `installNgStorageBridge()` in place, `get_wallets()` returned in 5 ms
    (`NEXTGRAPH-ISSUES.md` A7). **This was the real M0 risk, and it is now retired.**
  - a wallet was created against the public broker's published bootstrap, with no wallet UI, and a
    session started in our own page: `sessionId: 1`, a real `privateStoreId`. **Question 1 answered
    yes, empirically.**
  - `doc_create` created a document, `sparql_update` wrote a triple, and our own
    `selectSubjectQuery` + results parser read it back.
  - **C2 answered: `;`-separated updates ARE accepted** (`NEXTGRAPH-ISSUES.md` C2). A replace is one
    commit with no transient empty state, so `supportsMultiOperationUpdate` now defaults to true.
  - the full mapping round trip ran through a real NextGraph document: prop/vals -> triples ->
    SPARQL -> engine -> query -> triples -> prop/vals came back identical, with
    `hashMatches: true`, i.e. the cursor that push and pull share agrees with the real engine and
    not just with the fakes in the unit tests.
- **Durability: answered, and the answer is yes.** Against our own `ngd`: a triple
  written into a document before a reload was read back after it, from the same document, in a new
  session, with the data coming from the broker. Twice in a row. Guarded now by
  `e2e/tests/resume.spec.ts`, which asserts the wallet, the document and the data all survive.
  Getting there meant fixing three of our own defects, each of which produced an identical
  `RepoNotFound` and one of which forked the user's identity on every page load; the full account
  is `NEXTGRAPH-ISSUES.md` B4. The one real platform constraint that remains is that the broker
  sends a user's repos back *after* the connection opens, so a document must be remembered by nuri
  and reopened, never rediscovered by query at startup.
- **What was still open before that, for the record.** `user_connect` reached
  `wss://nextgraph.eu` and the broker closed the connection (`error: "Closing"`), because a
  self-created wallet is not registered with it (`NEXTGRAPH-ISSUES.md` B3). So nothing was synced,
  and the reload half of the test would confound "no local store" (B1, verified in source) with "the
  broker never accepted our data". Answering it empirically needs a registered account on a broker,
  or a local `ngd` — which does not build here (D3). Everything else in M0 is answered.
- The spike takes a broker invitation, a wallet file, or the public broker's bootstrap, so whichever
  becomes available first unblocks the last question.
- `packages/ng-engine` is the transport this proves: `wasm.ts` (the typed slice of the SDK we call,
  plus the boot probe A4 makes necessary), `session.ts` (wallet -> session -> document, mirroring
  NextGraph's own wallet app, since that sequence is documented nowhere else), `results.ts` (SPARQL
  JSON -> triples), `transport.ts` (the four-method `NgTransport`).

**M1. Mapping core. DONE.** `resourceToTriples` / `triplesToPropVals`, every datatype in
the table above, array ordering, SPARQL generation and escaping. Pure functions, round-trip tests.
- Exit met: 30 tests pass (`pnpm -C packages/bridge test`), `tsc --noEmit` clean. Round trips cover
  every datatype in section 5, arrays with order, localized text, and the lossy cases.
- Shipped in `packages/bridge/src`: `types.ts` (RDF terms), `vocab.ts` (XSD/RDF plus the three
  bridge-private predicates), `mapping.ts` (both directions), `sparql.ts` (serialization, escaping,
  subject-scoped updates), `base64.ts` (Loro snapshots, no Node or DOM globals).
- Deliberately dependency-free at runtime: the mapping imports nothing from `@tomic/lib`, it takes
  prop/vals plus a `DatatypeResolver`. That keeps it testable in plain vitest and keeps the version
  skew above confined to the adapter layer that M2 adds.
- Three concessions surfaced rather than hidden, each returned as a typed `MappingWarning` instead of
  being silently coerced: nested resources under `atomicURL`, arrays of nested resources, and unknown
  datatypes. See section 12.
- Independent of M0, so it was not wasted work if M0 forces a transport change.

**M2. Push. DONE (core).** Store event subscription, cursor, idempotent replace, echo
suppression.
- Exit: the behavioural exit below still needs M0's live engine. What is done and proven by test is
  every rule that decides *what* gets written: 49 tests pass, `tsc --noEmit` clean.
- `push.ts` — queue, debounce, chained single-flight flushes, per-subject sequential writes,
  re-queue on failure without blocking other subjects.
- `ports.ts` — `AtomicSource`, `NgTransport` (query/update/subscribe/close), `CursorStore`. The sync
  core imports neither `@tomic/lib` nor `@ng-org/*`, so it runs in plain vitest and the M0 outcome
  cannot invalidate it.
- `canonical.ts` — order-independent content hash of a subject's triples. This is the cursor, and it
  is what makes idempotent resume and echo suppression the same mechanism: a pulled write hashes to
  what is already recorded, so the push side has nothing to do. Tested explicitly, because the
  failure mode is an infinite push/pull loop.
- `atomic-store-source.ts` — the only file that touches `@tomic/lib`: `ResourceUpdated` /
  `ResourceSaved` / `ResourceRemoved`, plus a datatype cache that warms every property a snapshot
  mentions before handing it over, so the mapping stays sync.
- Cursors are written only after the write lands, so an interrupted push retries rather than being
  silently skipped. Covered by a resume test.
- **Design change made during M2:** the delete half of a replace names only the predicates the bridge
  itself wrote (`deletePredicatesUpdate`, `preserveForeignPredicates`, on by default). The wholesale
  `DELETE { <s> ?p ?o }` in section 6 would have destroyed any property a NextGraph-native app added
  to a mirrored subject on our very next push. Section 6's SPARQL is superseded by this.
- Still to do for the behavioural exit: edit a cell in a local-only Atomic drive and see the triple
  in NextGraph within a second; kill the tab mid-edit, reopen, no duplicate and no lost write. Both
  need a live engine, so they run with M0.

**M3. Pull. DONE (core).** `doc_subscribe`, reverse mapping, ordinary local commit, echo
suppression the other way.
- Exit: the live half needs M0's engine. The logic is done and tested: 59 tests in
  `packages/bridge`, `tsc --noEmit` clean.
- `pull.ts` reads a subject's triples, maps them back through the same datatype table, and applies
  them via the sink's ordinary commit path, then records the cursor **after** the local write lands.
- **Push and pull share one cursor store, and that is the entire echo-suppression mechanism.** The
  test that matters (`test/pull.test.ts`, "does not loop") wires a real puller and a real pusher to
  one store, has the pull apply a NextGraph-side write, lets that write fire a local change event,
  and asserts the pusher skips it and writes nothing back. A companion test asserts a genuine local
  edit made after a pull still propagates, so the suppression is not just "never push".
- Two deliberate refusals to destroy data, both tested: pull does not delete a local resource it has
  no cursor for (an absence is not an instruction), and `shouldPull` scopes which subjects in a
  shared document are ours to mirror at all.
- Still to do for the behavioural exit: write a triple into the document from outside the app and
  watch it appear in a live table.

**M3.5. One bridge object. DONE.** The pieces above, wired.
- `atomic-store-sink.ts` — the pull side's landing point in `@tomic/lib`: `set()` + `save()`, the
  same path a user's edit takes, so a pulled change is an ordinary local commit. Creates unknown
  subjects under the local-only drive, keeping the subject NextGraph already uses.
- `cursor-idb.ts` — the durable cursor store, keyed per drive.
- `bridge.ts` — `createBridge({source, sink, transport, cursors})` with `start`/`stop`/`flush`/
  `pullAll` and a status object. **`start()` pulls once before it starts pushing**, and that order is
  load-bearing: pushing first would let a stale local resource overwrite a NextGraph-side edit made
  while the app was closed, because push has no cursor for it and would treat it as new. There is a
  test for exactly that scenario.
- 65 tests.

**M4. The real app. IN PROGRESS: the bridge runs inside the real data-browser.**
Package the existing component layer and run it over a local-only drive with the bridge attached.
- Exit: tables, forms and kanban all work with no AtomicServer and nothing we host, data visible in
  NextGraph. Note the precise claim: a broker is still required for the NextGraph side to be durable
  (`NEXTGRAPH-ISSUES.md` B1), so this is "no server we run," not "no server anywhere."
- **How, decided.** Not by importing `data-browser` as a library: it is `private: true`,
  has no library entry point, and its components assume the app's own router and providers. Turning
  it into a published component library is weeks of packaging work on a codebase every AtomicServer
  user depends on, and it is not what proves the bridge.
  Instead, in order:
  1. **Run `data-browser` itself against a local-only drive with the bridge attached.** The
     no-signup path already exists and ships (`chunks/Demo/guestAgent.ts` mints a throwaway
     `did:ad:agent:` and calls `registerLocalOnlyDrive`; `demoWorkspace.ts` builds a workspace with
     tables and boards). Attaching the bridge to that drive gives the real Tables/Forms/Kanban UI,
     no AtomicServer, data mirrored into NextGraph, with zero packaging work. This is the demo.
  2. **Then, only if ELFA needs embedding**, extract the component layer as a package. Doing it in
     this order means the extraction is driven by a working thing rather than by guesswork about
     what ELFA's shell wants.
- **Built as `packages/ui` (`@tomic/ng-bridge-react`)**: `attachNgBridge.ts` (engine +
  session + document + both adapters + `createBridge`), `useNgBridge.ts` (flag handling, drive
  tracking, lifecycle), `NgBridgeBadge.tsx` (a visible sync indicator), `status.ts`. Enabled with
  `?ngbridge=1`, off otherwise, and everything heavy is behind a dynamic import so a normal session
  loads none of it.
- **Containment is a requirement, not an accident.** It was first written inside data-browser's own
  `src/chunks/NgBridge/`, then moved out here so that *no NextGraph code lives in
  `atomic-server`*. The host app's entire footprint is one dependency and one line:
  `<NgBridgeBadge store={store} />`. The component takes the `Store` as a prop rather than reading
  `@tomic/react`'s context, which is what lets this package depend on `@tomic/lib` types alone and
  keeps it usable from any Atomic app, not just data-browser.
  Two nice consequences: a host app's translation extractor never sees the badge's strings (they
  were being swept into all four of data-browser's `.po` catalogs before the move), and dropping the
  mirror is reverting one commit.
- **On its own branch**, `feat/ng-bridge` in `../atomic-server` (commit `a27cad9`), deliberately not
  on the feature branch that repo is currently working on.
- **WORKING, verified.** `pnpm dev` in data-browser, `/app/demo?ngbridge=1`, no
  AtomicServer running anywhere. The demo workspace builds a real local-only drive; the bridge
  creates its NextGraph document and reports `Live` with an empty queue. Queried straight out of
  the NextGraph document afterwards, **9 subjects, as ordinary RDF with Atomic property URIs**:

  | Subject | Triples | What it is |
  | --- | --- | --- |
  | `did:ad:20kJ…` | 11 | the drive, "Atomic Demo", with `default-ontology` and `write` rights |
  | `did:ad:drK5…` | 7 | the "Welcome 👋" document |
  | `did:ad:ao_X…` | 7 | the "Meetings" **table** |
  | `did:ad:LQ3O…` | 9 | "Onboarding meeting", a row, carrying the demo ontology's own `meetingLeader` property |
  | 4 × `did:ad:…` | 8 each | chatrooms and folders |
  | `did:ng:o:NCEC…` | 1 | our own marker triple, correctly excluded from pulls |

  Every resource carries both `isA` and `rdf:type`, so a native NextGraph consumer can query
  `?s a <Class>` without knowing anything about Atomic. A custom property from the demo's own
  ontology (`meetingLeader`) round-trips with no configuration, which is the schema-agnostic mapping
  doing what it was designed for.
- **Two bugs the live run found, both fixed, both the kind unit tests could not have caught:**
  1. **An infinite push/pull loop.** `lastCommit` changes on *every* save, so a pulled change minted
     a new one, push wrote it to NextGraph, the subscription fired, pull applied it, forever. It
     wedged the browser tab. The content-hash cursor cannot stop this: the content genuinely differs
     each round. Fixed by never mirroring commit bookkeeping (`VOLATILE_PROPERTIES` in `vocab.ts`),
     with a regression test naming the incident. **The general rule this taught: mirror the user's
     data, never the local commit system's.**
  2. **A pull storm.** Every push notifies the document subscription, and each notification re-read
     *every* subject — so one edit to a drive of N resources cost O(N) queries, and the demo's
     scripted typing saturated the main thread and froze the tab. This is PLAN §12 item 10 (the
     document-grained subscription) turning from a note into a bug. Fixed by coalescing
     notifications (`pullDebounceMs`, default 750ms) and collapsing overlapping reads, with a test
     asserting 25 notifications cost at most 3 reads.
  3. **"Not loaded" was treated as "deleted".** The push adapter returned `undefined` for any
     resource that was not ready, and `undefined` means *delete it from NextGraph*. A slow load, or
     a subject the store could not resolve, would therefore have deleted the user's data. Now only
     an actual `ResourceRemoved` event means deletion; anything else throws and is retried. Also
     added a 2s snapshot timeout, because `getResource` on an unresolvable subject waits on its own
     10s network timeout and pushes are sequential, so one such subject stalled everything behind it.
  4. **Pulling our own bookkeeping.** `findOrCreateDocument` writes `<doc> a <AppClass>` so the
     document can be found again; the pull side then tried to materialize the document's own nuri as
     an Atomic resource. Fixed in the puller (the document's nuri is excluded by default) and in the
     app (`did:ng:` subjects are not ours to materialize).

**M5. Identity. WIRED.** One secret for the user, and continuity across reloads.
- **The Atomic key is derived from the NextGraph wallet** (`packages/ng-engine/src/identity.ts`):
  HKDF-SHA256 over the opened wallet's key material, domain-separated (`atomic-ng-bridge/atomic-agent/v1`)
  and salted with the wallet id. Same wallet, same `did:ad:agent:` identity, every device, nothing
  extra to back up. An Atomic private key is 32 raw bytes, so the derived bytes are used directly.
  9 tests: determinism, per-wallet separation, that the wallet key is not handed back, and that the
  encoding matches Atomic's own.
- **Storing it in the wallet would have been better, and is not possible.** NextGraph's wallet has a
  purpose-built `third_parties` slot with working engine-side operations, but the only JS entry
  point (`wallet_update`) is `unimplemented!()` — `NEXTGRAPH-ISSUES.md` A11, worth reporting
  upstream since the gap is small and the payoff is not.
- **The wallet now persists** (`packages/ui/src/walletStorage.ts`): the encrypted wallet file is kept
  in IndexedDB and reopened on the next load, so identity and document survive a reload instead of a
  fresh throwaway wallet each time. A wallet that fails to open is discarded rather than left
  blocking the user.
- **The mirror will not replace an agent the app already set** (`packages/ui/src/atomicAgent.ts`).
  Rights in Atomic are per-agent, so swapping identity underneath an existing workspace locks a user
  out of their own data. Wallet login has to happen before a workspace exists, which makes it the
  app's call; the handle reports `identity: 'wallet' | 'app'` so the app can tell which happened.

**M5b. Passkey unlock. DONE.** The wallet password is no longer a secret in plain sight.
- `packages/ui/src/passkey.ts` — WebAuthn PRF: a passkey produces a stable 32-byte secret, HKDF
  turns it into an AES-GCM key, and that wraps the wallet password. Unlocking is a fingerprint;
  nothing is typed and nothing is stored in the clear.
- **Wrapped, not derived.** The password could have been the PRF output directly, storing nothing
  at all, but wrapping keeps two doors open that matter: a second device can wrap the *same*
  password under its own passkey, and the password can be exported deliberately if someone has to
  open their wallet without their authenticator. Deriving would make the authenticator a single
  point of failure for the data.
- `walletPassword.ts` is the order of preference: passkey if configured, generated localStorage
  password otherwise. The upgrade between them is user-initiated on purpose — WebAuthn needs a
  gesture, and a fingerprint prompt nobody asked for on page load would be both broken and rude.
  The badge offers it only while the stopgap is still in use, and shows 🔑 once it is not.
- The upgrade saves the wrapped copy **before** dropping the plaintext one, so an interruption
  anywhere leaves the wallet openable rather than lost.
- What a passkey cannot fix: it is per-device unless the platform syncs it, so losing every
  authenticator with no export loses a wallet this code generated. For a user's own wallet the
  recovery story is NextGraph's, which is the configuration a real deployment should use.

**M5d. Wallet-first sign-in. DONE.** The order that makes the identity portable:
wallet -> Atomic identity -> workspace -> mirror.
- `packages/ui/src/NgSignIn.tsx` + `signIn.ts`: one panel, three ways in — continue with the wallet
  saved in this browser, open a `.ngw`, or create a NextGraph identity. Nothing about agents, DIDs
  or keys is shown, because none of it is the user's to manage. `ensureWorkspace` then creates a
  local-only drive owned by the derived agent, following data-browser's own recipe (register
  local-only *between* creation and first save).
- **Still one line in the host app.** The badge is the single mount point: it renders the sign-in
  panel when nobody is signed in, and the status pill afterwards.
- **Verified end to end in the browser**: from cleared storage, "Create a NextGraph
  identity" produced a wallet, a derived `did:ad:agent:` identity, a workspace, and a live mirror
  into `did:ng:o:ImdGL…`, with the badge reading `Live`. After a reload the *same* agent and the
  *same* drive came back — derivation and persistence both hold.
- **Three bugs found by running it, all fixed:**
  1. **Two wallets per page.** Sign-in and the mirror each opened their own, so the page had two
     derived identities and a document neither could reach. Session acquisition now lives in
     `ngSession.ts` behind one cached promise.
  2. **`WalletAlreadyAdded`** when the same wallet was opened twice. The `get_wallets()` check is
     advisory; the error is authoritative, so it is now caught and treated as "already imported".
  3. **The sign-in panel shown to someone already signed in**, because the store hydrates its agent
     asynchronously and the badge read it once at mount. It follows `AgentChanged` now.
- **A reload restores the NextGraph side too** (`NEXTGRAPH-ISSUES.md` B4). The
  wallet is reopened from the local broker's own store rather than re-imported from the saved file,
  the connection is established with the string user id the session returns, and the document is
  reopened by remembered nuri while the broker sends it. Without a broker the mirror still degrades
  to "Not connected" with an explanation and the app carries on, because the Atomic side is durable
  by itself.

**M6. The engine in a worker. DONE. Running in a browser, and the default.**
- Why: every SPARQL call runs synchronously inside the wasm, and on the main thread that competes
  with the app's rendering and with Atomic's own Loro work. It froze the tab twice while building
  this. NextGraph's `api-web` runs the wasm in a worker for the same reason, so this is the
  supported shape, not a workaround — and it is what Option 11 specified in the first place.
- `packages/ng-engine/src/worker/`: `protocol.ts` (request/response plus one document-changed
  event), `engineWorker.ts` (wasm, wallet, session, subscriptions — all of NextGraph lives here),
  `client.ts` (the page's side, handing back the same `NgTransport` as the in-page engine).
- **Nothing above the transport changes.** The bridge, the mapping and both sync directions cannot
  tell which engine they are talking to. That is what the four-method seam in section 4 was for.
- Two things still cross the boundary, both deliberately: the wasm's storage messages, which a
  worker posts to the *page* because that is where storage lives (A7, same handler pointed at the
  worker); and the derived Atomic private key, because the page signs Atomic commits. **The wallet
  itself never leaves the worker** — a narrower thing to hand out than the wallet it came from.
- 6 tests on the wiring that fails silently if it drifts: id correlation with out-of-order answers,
  error propagation across the boundary, subject fill-in, per-document event routing, unsubscribing
  only when the last listener leaves, and ignoring the wasm's own storage traffic on the same
  channel (a dropped correlation is a promise that never settles, which looks exactly like a slow
  engine).
- **Brought to parity with the page path.** As built, the worker could open a wallet
  file or create a wallet, and did neither of the two things cross-session persistence turns out to
  need: reopening a wallet the local broker already holds (`saved`), and connecting to a broker at
  all. Wiring it up in that state would have reintroduced B4 on a path with no test covering it.
  `openSession.ts` now holds that logic, separately from the message plumbing so it can be tested
  without standing up a worker, and 6 tests cover it: open by name rather than re-import, connect,
  survive a broker that refuses us, hand back the new wallet's bytes for the page to save, survive
  a failed export, and hand over the derived key rather than the wallet.
- **Wired and verified.** Both engines now implement one interface (`engine.ts`), so
  `packages/ui` picks one and nothing above it changes; `atomic.ngBridge.engine=page` in
  `localStorage` switches back. The e2e reload test asserts `mode === 'worker'`, because the
  fallback to the page engine is deliberately silent — right for a user, wrong for a test that
  would otherwise stay green while the wasm crept back onto the main thread.
- **Three configuration costs in the host, all found by running it:**
  1. `vite-plugin-wasm` has to apply to worker builds (`worker.plugins`), which does not inherit
     from the main plugin array.
  2. `server.fs.allow` has to include the bridge checkout. Vite serves the worker entry over
     `/@fs/…` as its own request and refuses paths outside the workspace root, so a linked sibling
     package 403s. Only an issue while linked for development; from a registry it is in
     `node_modules`. The 403 was invisible except in the network log, and presented as the mirror
     never starting.
  3. `@ng-org/lib-wasm` belongs in `optimizeDeps.exclude`, for the reason the host's own config
     already documents for `loro-crdt`: a prebundled wasm dep hangs on init rather than failing.
- **One real bug this shook out.** Routing the reload through `saved` looked obviously right and
  was wrong: `wallet_create` is called with `local_save: false`, so a newly created wallet is not
  in the local broker's list at all and cannot be opened by name until something imports it. The
  reload therefore goes through the saved file with `inMemory: false`, which imports it the first
  time and opens it by name every time after. Two tests hold that line.

**M5c. Polish.** The security note on in-browser wallet handling, lifecycle hardening, docs.

---

## 9. Risks and open questions

Ordered by how much damage they do if they turn out badly.

1. **NextGraph has no durable local store in the browser. Settled, and the answer is the bad one.**
   Verified in NextGraph's source, not inferred: in a browser session the graph lives in an in-memory
   oxigraph store with an `InMemoryUserStorage`, `load()` is gated behind a persistence check that is
   false there, and the IndexedDB-backed store is marked "not ready yet." Full citations in
   `NEXTGRAPH-ISSUES.md` B1. Data written by the app survives a reload only because a broker accepted
   it and serves it back, so a broker is a hard dependency of the NextGraph side.
   This does not sink the project, and it is an argument *for* the mirror: Atomic's OPFS store is the
   durable local copy, and the app keeps working with the broker unreachable. It does change what we
   can honestly claim, to "no server we run, and none the consortium has to operate on our behalf"
   rather than "no server anywhere in the loop." Every document making the stronger claim has been
   corrected. **M0 now confirms the consequence rather than discovering the answer.**
2. **Version skew.** Published `lib-wasm` is alpha and behind its sibling packages. Pin everything
   explicitly, record the exact versions here, and re-verify against any broker we target.
   Symptoms of skew are silent (no error, empty reads), so add a startup probe that asserts the
   methods we depend on exist.
3. **Wallet material in our app.** Direct consequence of choosing the embedded engine. Needs a
   written security note and a review before shipping, not just a mention.
4. **Mirror merge semantics.** Two systems, reconciled after the fact. Fine for turn-taking use,
   last-write-wins per resource for genuinely concurrent cross-system edits (pull applies the
   NextGraph version of a subject whole, see `atomic-store-sink.ts`). Document it; do not imply
   a shared CRDT.
5. **`;`-separated SPARQL updates.** Unverified. Falls back to two commits if unsupported.
6. **Loro rich-text documents.** They round-trip as opaque base64 on the NextGraph side. A native
   NextGraph consumer cannot read their content. Worth being explicit about rather than letting it
   be discovered.
7. **Worker placement.** With the embedded engine the sync layer may be able to run off the main
   thread, unlike the iframe path where it definitively cannot. Not assumed either way, and not
   required for correctness since sync only runs while the app is open. Revisit after M0.

## 10. Version pinning

Record exact versions here whenever they change, because skew failures are silent.

| Package | Pinned | Note |
| --- | --- | --- |
| `@tomic/lib` | `link:../../../atomic-server/browser/lib` (0.41.0-beta.2) | **not published.** npm's latest is `0.40.0`, latest beta `0.41.0-beta.0`, and that beta predates the `lorodoc` and `localizedText` datatypes this mapping needs (`PropVals` is also still `Map<string, JSONValue>` there). We develop against the local build. Nothing ships until this is published. |
| `@ng-org/lib-wasm` | `0.1.2-alpha.6` | published; lags its siblings. A CI test greps its typings for every method we call, so a bump that renames one fails there rather than silently at runtime (A4). |
| `@playwright/test` | `1.60.0` | e2e only, matching `atomic-server/browser/e2e` |
| `@ng-org/web` | not used | iframe path, rejected in section 4 |
| `@ng-org/orm` | not used | generic triples instead, see section 5 |

## 11. Running it

```bash
pnpm install
pnpm -r test        # 92 tests across bridge, ng-engine and ui. No browser needed.
pnpm -r typecheck
```

**The app, with the mirror** (this is the thing to show someone):

```bash
cd ../atomic-server && git checkout feat/ng-bridge
cd browser && pnpm install
cd data-browser && pnpm dev --port 6750
# then: http://localhost:6750/?ngbridge=1
```

You get "Continue with NextGraph". Signing in creates (or opens) a wallet, derives the Atomic
identity from it, makes a workspace, and starts mirroring. `?ngbridge=0` turns it off again.

**The M0 engine harness**, for questions about the SDK rather than the product:

```bash
pnpm spike          # http://localhost:5190
```

Open a wallet file or use the public broker's bootstrap, then walk the buttons left to right. Its
log is written to be pasted into `NEXTGRAPH-ISSUES.md` as evidence.

**The demo, recorded**: see `e2e/README.md`.

## 12. UX concessions, running list

Every place the mirror cannot be invisible to a user. Kept here rather than discovered late.

1. **Rich text is opaque on the NextGraph side, and stays that way deliberately.** A `lorodoc`
   (Atomic's Loro-backed rich text) round-trips exactly, as base64 under a bridge datatype, but a
   NextGraph-native app sees an unreadable blob where a document body would be. Tables, forms and
   kanban field data are all ordinary legible RDF; long-form prose is the only affected surface.
   **Decision: we are not fixing this.** A derived plain-text triple alongside the blob
   would make prose readable and searchable for native consumers, cheaply, at the cost of being
   one-way. We are not adding it, because long-form documents are WP5's remit (BlockNote), and a
   WP6 app quietly becoming a second document store is how a consortium starts duplicating work.
   The right shape is that BlockNote owns documents and our tables link to them by URL, which is the
   cross-app pattern WP5 and WP8 already committed to. Revisit only if WP5 asks for it.
2. **Nested resources are not traversable as triples.** An Atomic resource inlined under an
   `atomicURL` property is stored as a JSON-AD literal. Exact for us, opaque to native consumers, and
   a `lossy-nested-resource` warning either way. Arrays of nested resources degrade the same way, to
   a single JSON literal instead of member triples.
3. **Array order is bookkeeping, not semantics.** RDF has no order. A NextGraph-native writer that
   appends a member without updating the bookkeeping triple gets that member appended in sorted
   position on the Atomic side, not at the end of the user's list. Deterministic, but it is not the
   position that writer intended, and there is no way to recover the intent.
4. **Two systems, reconciled after the fact.** Simultaneous edits to the same field from both sides
   inside one sync window are last-write-wins per field. Turn-taking use never sees this.
5. **Attribution.** Pull-side writes are ordinary local commits signed by whichever identity the app
   holds. In the embedded-engine model that is the user's own, which is the good outcome, but any
   design where a service identity does the writing shows collaborators "the Bridge" as the author of
   their colleague's edit.
6. **Two identities until the derivation exists.** A NextGraph wallet plus Atomic's device-level
   agent. The intent is that the second is derived and invisible; that mechanism is not designed yet,
   and the two permission models differ in kind (capability vs. agent-plus-rights).
7. **NextGraph's commit log fills with bridge churn.** *(Softened: the engine does accept
   `;`-separated updates, so an edit is now **one** commit, not two, and there is no window where the
   subject has no properties.)* It is still a whole-subject replace. A NextGraph-native user reading that document's history sees mechanical replaces, not
   "Alice renamed the column". Version history on the NextGraph side is not a usable audit trail for
   mirrored data, and should not be presented as one.
8. **A lost cursor store leaves deleted resources behind.** The bridge deletes only predicates it has
   a record of writing. If the cursor store is cleared and a resource is then deleted locally, its
   triples stay in the NextGraph document. Deliberate: the alternative, a wildcard delete, destroys
   properties a NextGraph-native app added to the same subject. Leaving stale data is recoverable;
   destroying someone else's data is not. A full re-sync is the repair.
9. **3 MB gzipped of engine before the first row of data.** The published NextGraph wasm is 8.1 MB
   raw, 3.0 MB gzipped (`NEXTGRAPH-ISSUES.md` A6), and the embedded-engine decision means we ship it
   ourselves rather than letting a hosted wallet page carry it. On a slow connection that is the
   first thing a user waits for. The app's own local data works without it, so the honest mitigation
   is to load the engine lazily and let the app be usable while it arrives, rather than blocking
   first paint on the mirror.
10. **A NextGraph-side change means re-reading the whole document.** `doc_subscribe` reports that
    *something* in the document changed, not what, so every notification costs a subject listing plus
    a read per subject. Fine for a table; not fine for a large drive in one document, and it argues
    for mirroring into several documents rather than one, before the shape is fixed.
11. **Broker reachability is user-visible.** Per `NEXTGRAPH-ISSUES.md` B1, NextGraph has no durable
   local store in a browser: with the broker unreachable, the app keeps working against Atomic's own
   OPFS store but the NextGraph side is not merely behind, it holds nothing new. Sync state needs to
   say which side it means, or it becomes a promise the app cannot keep.

## 13. The demo

`e2e/` is one Playwright test that asserts the whole claim and records itself doing it: the app runs
with no AtomicServer, its data is in a real NextGraph document, an edit in the app appears there,
and a write made into NextGraph comes back. Each step is an assertion, so a broken bridge fails the
test rather than producing a convincing video of nothing happening. `pnpm demo:video` writes
`docs/ng-bridge-demo.mp4`. See `e2e/README.md` for what it needs and what it will honestly fail on.

One lesson from building it, worth keeping: the first version's on-screen panel listed the
document's subjects and then read each one's triples — N+1 queries per refresh, through a wasm
engine on the main thread. While polling, that froze the tab it was supposed to be filming. The
panel now uses two queries. Instrumentation is not free when the thing you are instrumenting shares
your only thread.
