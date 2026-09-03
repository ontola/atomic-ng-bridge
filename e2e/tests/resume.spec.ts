import { expect, test, type Page } from '@playwright/test';

/**
 * The mirror resumes after a reload, into the same document, with the same
 * identity.
 *
 * This exists because that was broken at one point and none of the 114 unit tests
 * noticed, and could not have: the failure was in how the real SDK behaves,
 * and every unit test mocks it. Three separate causes each produced an
 * identical `RepoNotFound` (see `NEXTGRAPH-ISSUES.md` B4), and the worst of
 * them created a **new wallet, and therefore a new identity, on every page
 * load** while looking like a NextGraph limitation. The symptom a user would
 * report is "my data is gone"; the symptom in code is silence.
 *
 * So this test asserts the three things that were each independently wrong:
 *
 *   1. the wallet is the same one after a reload (no forked identity);
 *   2. the workspace mirrors into the *same* document, not a fresh one;
 *   3. a triple written before the reload is readable after it, which can only
 *      be true if a broker kept it and sent it back.
 *
 * Requires a broker that accepts our wallet, since (3) is precisely the thing
 * that has to survive the page. Point it at one with `NG_BOOTSTRAP_URL`, e.g.
 * a local `ngd`:
 *
 *   NG_BOOTSTRAP_URL=http://localhost:14400/.ng_bootstrap pnpm -C e2e demo
 */

/** Written before the reload, looked for after it. */
const PROBE_PREDICATE = 'https://example.org/resume-probe';
const PROBE_VALUE = 'written-before-the-reload';

const BOOTSTRAP_KEY = 'atomic.ngBridge.bootstrapUrl';

type BridgeState = {
  graph: string;
  walletName: string;
  userId: string;
  mode: 'page' | 'worker';
};

declare global {
  interface Window {
    __ngBridge?: {
      graph: string;
      session: { walletName: string; userId: string };
      /** Which engine is running. Asserted, so a silent fallback is a failure. */
      engine: {
        mode: 'page' | 'worker';
        listDocuments: (appClass: string) => Promise<string[]>;
      };
      transport: {
        update: (sparql: string) => Promise<void>;
        queryValues: (sparql: string, variable: string) => Promise<string[]>;
      };
    };
  }
}

/**
 * Waits for the mirror to be running and reports what it is bound to.
 *
 * Generous, and deliberately so: after a reload the wallet is reopened, the
 * broker connection is established, and only then does the broker start
 * sending the user's repos back. That last step is asynchronous, which is the
 * one real constraint the platform imposes (B4), so a short timeout here would
 * make this test flaky for the same reason the bug was hard to find.
 */
async function waitForMirror(page: Page): Promise<BridgeState> {
  await page.waitForFunction(() => window.__ngBridge !== undefined, undefined, {
    timeout: 180_000,
  });

  const state = await page.evaluate(() => {
    const bridge = window.__ngBridge!;

    return {
      graph: bridge.graph,
      walletName: bridge.session.walletName,
      userId: bridge.session.userId,
      mode: bridge.engine.mode,
    };
  });

  // Every field is checked for substance here, not just compared later. Two of
  // the assertions in this test are equality checks between the two loads, and
  // `undefined === undefined` would pass while proving nothing at all.
  expect(state.graph).toMatch(/^did:ng:/);
  expect(state.walletName).toEqual(expect.any(String));
  expect(state.walletName.length).toBeGreaterThan(0);
  expect(state.userId).toEqual(expect.any(String));
  expect(state.userId.length).toBeGreaterThan(0);

  return state;
}

test('the mirror resumes into the same document after a reload', async ({
  page,
}) => {
  test.slow();

  const bootstrapUrl = process.env.NG_BOOTSTRAP_URL;

  // Skipped rather than failed without one, because the public broker refuses
  // wallets it has not registered (`NEXTGRAPH-ISSUES.md` B3), so there would be
  // nothing to hold the data across the reload and the failure would look like
  // a bug in the mirror rather than a missing prerequisite.
  test.skip(
    bootstrapUrl === undefined,
    'Needs a broker that accepts our wallet: set NG_BOOTSTRAP_URL.',
  );

  // Set before any app code runs, because wallet creation reads it once.
  await page.addInitScript(
    ([key, url]) => localStorage.setItem(key as string, url as string),
    [BOOTSTRAP_KEY, bootstrapUrl!],
  );

  // 1 · Sign in, which creates this browser's wallet ------------------------
  await page.goto('/?ngbridge=1');
  await expect(page.getByText('Continue with NextGraph')).toBeVisible({
    timeout: 60_000,
  });

  await page
    .getByRole('button', { name: /NextGraph identity|^Continue$/ })
    .first()
    .click();

  const before = await waitForMirror(page);

  // 2 · Write something that only a broker can give back --------------------
  // Through the mirror's own transport rather than the UI: this test is about
  // the document surviving, and a UI edit would also be re-pushed from the
  // durable Atomic side after the reload, which would pass even if NextGraph
  // had kept nothing at all. A triple that exists *only* in NextGraph cannot.
  await page.evaluate(
    async ([predicate, value]) => {
      const bridge = window.__ngBridge!;

      await bridge.transport.update(
        `INSERT DATA { GRAPH <${bridge.graph}> {
           <${bridge.graph}> <${predicate}> "${value}" } }`,
      );
    },
    [PROBE_PREDICATE, PROBE_VALUE],
  );

  // Give the write time to reach the broker before the page goes away. The
  // outbox drains on its own, but a reload mid-flight is not what this test is
  // measuring.
  await page.waitForTimeout(5_000);

  // 3 · Reload, which is the whole test -------------------------------------
  await page.reload();

  const after = await waitForMirror(page);

  // Identity first: a new wallet here means a new NextGraph user, new stores,
  // and a document nobody can reach. That is what used to happen.
  expect(after.walletName).toBe(before.walletName);
  expect(after.userId).toBe(before.userId);

  // The same document, not a rival created because discovery ran too early.
  expect(after.graph).toBe(before.graph);

  // And the data, which can only have come from the broker.
  const probe = await page.evaluate(
    async ([predicate]) => {
      const bridge = window.__ngBridge!;

      return bridge.transport.queryValues(
        `SELECT ?o WHERE { GRAPH <${bridge.graph}> {
           ?s <${predicate}> ?o } }`,
        'o',
      );
    },
    [PROBE_PREDICATE],
  );

  expect(probe).toContain(PROBE_VALUE);

  // No orphans. This checks the *symptom* of the discovery race rather than
  // its timing: whenever a reload wrongly concludes the workspace has no
  // document, it leaves a second one behind carrying nothing but its own class
  // triple. Five reloads once produced five of them. Asserting the count holds
  // regardless of how fast the broker happens to be, which matters because
  // against a local broker the race simply does not occur, so a test that
  // waited for it to fail would prove nothing.
  const documents = await page.evaluate(() =>
    window.__ngBridge!.engine.listDocuments('did:ng:z:AtomicDriveMirror'),
  );

  expect(documents).toHaveLength(1);

  // The engine belongs in a worker, and falling back to the main thread is
  // silent by design so a bundler problem cannot take the mirror down with it.
  // Silent is right for a user and wrong for a test: without this, the whole
  // suite would keep passing while the wasm quietly moved back onto the thread
  // it was competing with.
  expect(after.mode).toBe('worker');
});
