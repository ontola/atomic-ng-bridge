# The demo, as a test

Two Playwright tests. `demo.spec.ts` proves the whole claim and records itself doing it.
`resume.spec.ts` proves the mirror survives a page reload.

What it asserts, in order:

1. A mature Atomic app (tables, forms, kanban) runs with **no AtomicServer** anywhere.
2. Its data is in a **real NextGraph document**, as ordinary RDF.
3. An **edit made in the app** appears in NextGraph within seconds.
4. A **write made into NextGraph** comes back into the app.

Each step is an assertion, so a broken bridge fails the test rather than producing a
convincing-looking video of nothing happening. The on-screen panel showing both sides is
deliberate: without it, a viewer has to take the NextGraph half on faith, which is exactly what a
demo should not ask of a sceptical audience.

## Running it

The app under test is `atomic-server`'s data-browser on the **`feat/ng-bridge`** branch, which is
where the one-line integration lives. It has to be running already — its dev server needs wasm
assets built out of band, so starting it from here would turn someone else's build problem into a
mysterious test failure.

```bash
# 1. the app, on the branch that has the bridge
cd ../../atomic-server && git checkout feat/ng-bridge
cd browser/data-browser && pnpm install && pnpm dev --port 6750

# 2. the demo
cd ../../../atomic-ng-bridge/e2e
pnpm demo         # runs it, writes artifacts/**/video.webm
pnpm demo:video   # the same, then converts to ../docs/ng-bridge-demo.mp4

# 3. the reload test, which needs a broker that accepts our wallet
NG_BOOTSTRAP_URL=http://localhost:14400/.ng_bootstrap pnpm demo
```

`DEMO_URL` overrides the app's address if you serve it somewhere else.
`NG_BOOTSTRAP_URL` points wallet creation at a broker of your own; without it `resume.spec.ts`
skips rather than failing, because there would be nothing to hold the data across the reload.

## `resume.spec.ts`, and why it exists

Cross-session persistence was broken at one point, and none of the unit tests noticed or could have:
the failure was in how the real SDK behaves, and every unit test mocks it. Three separate causes
each produced an identical `RepoNotFound` (`NEXTGRAPH-ISSUES.md` B4), the worst of which created a
**new wallet, and therefore a new identity, on every page load** while looking like a platform
limitation. So this test asserts the three things that were each independently wrong: the same
wallet after a reload, the same document, and a triple written before the reload readable after it.
That last one is written through the mirror's transport rather than the UI on purpose: an edit made
in the app would be re-pushed from the durable Atomic side after a reload and would therefore pass
even if NextGraph had kept nothing at all.

It also asserts that exactly one document carries the app's class triple. That checks the *symptom*
of the discovery race rather than its timing, which matters: against a fast local broker the race
does not occur at all (verified by disabling the fix and watching the test still
pass), so an assertion that depended on provoking it would prove nothing.

## What it needs, and what it will honestly fail on

- **A broker connection.** The bridge creates a throwaway wallet against `nextgraph.eu`. That
  broker refuses unregistered wallets (`NEXTGRAPH-ISSUES.md` B3), so the NextGraph side is
  in-memory: the demo is real, the durability is not. With a registered account (a `.ngw` file and
  its password, via the `wallet-file` connection kind) the same run is durable.
- **Time.** Wallet creation, the first sync and the demo workspace take a while; the test's timeouts
  are generous on purpose and the driver is deliberately slowed, because the recording is for people
  to watch.
- **The demo workspace's own scripted editing.** `/app/demo` runs a director that types into
  documents by itself. That is honest — it shows live editing flowing through — but it makes the
  page busy, and it is why the panel reports numbers rather than relying on the app's own UI to
  show NextGraph state.
