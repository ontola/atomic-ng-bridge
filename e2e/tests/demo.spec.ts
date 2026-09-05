import { expect, test, type Page } from '@playwright/test';

/**
 * The demo, as a test.
 *
 * The claim, in order:
 *   1. A mature Atomic app runs with no AtomicServer anywhere.
 *   2. Signing in with a NextGraph wallet is the whole of identity.
 *   3. The workspace is mirrored into a real NextGraph document, as RDF.
 *   4. A table, with rows typed into it, appears in NextGraph within seconds.
 *   5. A write made *into NextGraph* comes back into the table.
 *
 * Each step is an assertion, so a broken bridge fails the test rather than
 * producing a convincing video of nothing happening.
 *
 * It signs in and works in its own fresh workspace rather than using the app's
 * demo route. That is not tidiness: the demo route runs a scripted typist on
 * top of the NextGraph engine, and the contention froze the tab this test is
 * meant to film.
 */

const NAME = 'https://atomicdata.dev/properties/name';
const BOOTSTRAP_KEY = 'atomic.ngBridge.bootstrapUrl';

/** The rows typed into the table, in order: name, then author. */
const BOOKS: [string, string][] = [
  ['Dune', 'Frank Herbert'],
  ['Neuromancer', 'William Gibson'],
  ['Solaris', 'Stanislaw Lem'],
];
const FROM_NEXTGRAPH = 'Dune Messiah';

/** The panel the video is built around: both sides, side by side. */
async function installOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.querySelector('#demo-panel') !== null) {
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'demo-panel';
    panel.innerHTML = `
      <div class="demo-cols">
        <div><h4>Atomic (this app, local)</h4><div id="demo-atomic">…</div></div>
        <div><h4>NextGraph document</h4><div id="demo-ng">…</div></div>
      </div>
      <div id="demo-caption"></div>`;

    const style = document.createElement('style');
    style.textContent = `
      #demo-panel { position: fixed; inset: auto 1rem 4rem auto; width: 32rem; z-index: 99999;
        background: rgba(18,18,20,.94); color: #eee; border-radius: 10px; padding: .9rem 1rem;
        font: 12px/1.55 ui-monospace, monospace; box-shadow: 0 8px 30px rgb(0 0 0 / 35%); }
      #demo-panel h4 { margin: 0 0 .35rem; font-size: 11px; letter-spacing: .04em;
        text-transform: uppercase; color: #9ad; font-weight: 600; }
      .demo-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
      #demo-caption { margin-top: .8rem; padding-top: .6rem; border-top: 1px solid #333;
        font-size: 13px; color: #fff; min-height: 1.4em; }
      .demo-hit { color: #6dd36d; font-weight: 700; }
      /* The app's toasts. The one this hides is the app reporting, correctly,
         that no AtomicServer answers: the dev config points it at a port
         nothing listens on (scripts/demo-up.sh), which is the whole claim.
         Everything else the panel reports comes from the two stores. */
      div[style*="z-index: 9999"][style*="inset: 16px"] { display: none; }`;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    const w = window as unknown as {
      demoCaption: (text: string) => void;
      demoRefresh: () => Promise<void>;
      store: {
        getDrive: () => string | undefined;
        getResource: (
          s: string,
        ) => Promise<{ getPropVals: () => Record<string, unknown> }>;
      };
      __ngBridge?: {
        graph: string;
        transport: {
          queryValues: (sparql: string, variable: string) => Promise<string[]>;
        };
      };
    };

    w.demoCaption = (text: string) => {
      document.querySelector('#demo-caption')!.textContent = text;
    };

    w.demoRefresh = async () => {
      const bridge = w.__ngBridge;
      const ngEl = document.querySelector('#demo-ng')!;
      const atomicEl = document.querySelector('#demo-atomic')!;
      const drive = w.store.getDrive();

      if (drive !== undefined) {
        const resource = await w.store.getResource(drive);
        const name = resource.getPropVals()[
          'https://atomicdata.dev/properties/name'
        ] as string | undefined;

        atomicEl.innerHTML = `workspace<br><span class="demo-hit">• ${
          name ?? '—'
        }</span>`;
      }

      if (bridge === undefined) {
        ngEl.textContent = 'connecting…';

        return;
      }

      // Two queries, never one per subject: an N+1 sweep through a wasm engine
      // on the main thread froze the tab this is filming.
      //
      // Rows are the subjects typed as a class the workspace itself defines.
      // Such a class is a mirrored resource, so its IRI sits under this
      // document (`did:ng:o:<doc>:q:`), unlike the built-in classes under
      // atomicdata.dev. A table brings its class, properties and views along
      // too; those are in the count, but the point is to watch rows arrive,
      // not to read the schema.
      const [subjects, rows] = await Promise.all([
        bridge.transport.queryValues(
          `SELECT DISTINCT ?s WHERE { GRAPH <${bridge.graph}> { ?s ?p ?o } }`,
          's',
        ),
        bridge.transport.queryValues(
          `SELECT ?o WHERE { GRAPH <${bridge.graph}> {
             ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?class .
             ?s <https://atomicdata.dev/properties/name> ?o
             FILTER(STRSTARTS(str(?class), "did:ng:o:")) } }`,
          'o',
        ),
      ]);

      ngEl.innerHTML =
        `${subjects.length} subjects · ${rows.length} table rows<br>` +
        rows
          .map(name => `<span class="demo-hit">• ${name}</span>`)
          .join('<br>');
    };
  });
}

const caption = async (page: Page, text: string, holdMs = 1800) => {
  await page
    .evaluate(
      ([message]) =>
        (window as unknown as { demoCaption: (t: string) => void }).demoCaption(
          message as string,
        ),
      [text],
    )
    .catch(() => undefined);
  await page.waitForTimeout(holdMs);
};

const refresh = (page: Page) =>
  page
    .evaluate(() =>
      (window as unknown as { demoRefresh: () => Promise<void> }).demoRefresh(),
    )
    .catch(() => undefined);

/** One query: which subject in the document carries this exact name? */
const subjectNamed = (page: Page, value: string): Promise<string | undefined> =>
  page.evaluate(async ([wanted]) => {
    const bridge = (
      window as unknown as {
        __ngBridge?: {
          graph: string;
          transport: {
            queryValues: (s: string, v: string) => Promise<string[]>;
          };
        };
      }
    ).__ngBridge;

    if (bridge === undefined) {
      return undefined;
    }

    const found = await bridge.transport.queryValues(
      `SELECT ?s WHERE { GRAPH <${bridge.graph}> {
         ?s <https://atomicdata.dev/properties/name> ?o
         FILTER(str(?o) = "${wanted}") } }`,
      's',
    );

    return found[0];
  }, [value]);

/**
 * The subject the app knows this NextGraph subject as. A mirrored resource is
 * written under a NextGraph IRI (`did:ng:o:<doc>:q:…`) and keeps its Atomic
 * subject locally; the document records the link, one triple per subject.
 */
const atomicSubjectOf = (page: Page, ngSubject: string): Promise<string> =>
  page.evaluate(async ([s]) => {
    const bridge = (
      window as unknown as {
        __ngBridge: {
          graph: string;
          transport: {
            queryValues: (q: string, v: string) => Promise<string[]>;
          };
        };
      }
    ).__ngBridge;

    const found = await bridge.transport.queryValues(
      `SELECT ?a WHERE { GRAPH <${bridge.graph}> {
         <${s}> <https://atomicdata.dev/ng-bridge/atomicSubject> ?a } }`,
      'a',
    );

    return found[0] ?? (s as string);
  }, [ngSubject]);

/** A cell in the grid: rows and columns are 1-based, and column 1 is the row number. */
const cell = (page: Page, row: number, column: number) =>
  page.locator(`[aria-rowindex="${row}"] > [aria-colindex="${column}"]`);

/** What the table shows for this row's name, straight from the app's store. */
const nameOf = (page: Page, subject: string): Promise<string | undefined> =>
  page.evaluate(
    async ([s, name]) => {
      const store = (
        window as unknown as {
          store: {
            getResource: (
              subject: string,
            ) => Promise<{ getPropVals: () => Record<string, unknown> }>;
          };
        }
      ).store;
      const resource = await store.getResource(s as string);

      return resource.getPropVals()[name as string] as string | undefined;
    },
    [subject, NAME],
  );

test('sign in with NextGraph, then mirror a table both ways', async ({
  page,
}) => {
  test.slow();

  // A broker of our own, when there is one: the public broker refuses wallets
  // it did not register (`NEXTGRAPH-ISSUES.md` B3). Set before any app code
  // runs, because wallet creation reads it once.
  const bootstrapUrl = process.env.NG_BOOTSTRAP_URL;

  if (bootstrapUrl !== undefined) {
    await page.addInitScript(
      ([key, url]) => localStorage.setItem(key as string, url as string),
      [BOOTSTRAP_KEY, bootstrapUrl],
    );
  }

  // 1 · The app, with nothing hosted behind it -----------------------------
  await page.goto('/?ngbridge=1');
  await expect(page.getByText('Continue with NextGraph')).toBeVisible({
    timeout: 60_000,
  });

  await installOverlay(page);
  await caption(
    page,
    'Atomic Tables, Forms and Kanban - running with no AtomicServer.',
    2500,
  );
  await caption(
    page,
    'One identity: a NextGraph wallet. No second account, no key to keep.',
    2000,
  );

  // 2 · Sign in ------------------------------------------------------------
  await page
    .getByRole('button', { name: /NextGraph identity|^Continue$/ })
    .first()
    .click();

  await expect(page.getByText(/NextGraph: Live/).first()).toBeVisible({
    timeout: 180_000,
  });
  await refresh(page);
  await caption(
    page,
    'Signed in. The workspace is mirrored into a NextGraph document.',
    2500,
  );

  // 3 · A table, typed into here, shows up there ---------------------------
  // Sign-in lands us in the new workspace on its own, without a page load: a
  // reload here would race the workspace still being written locally *and*
  // destroy the NextGraph session, whose stores do not survive one (B4).
  await expect(page.getByTestId('editable-title')).toBeVisible({
    timeout: 60_000,
  });
  await installOverlay(page);
  await caption(page, 'Creating a table from a template...', 1200);

  await page.getByRole('main').getByRole('button', { name: 'New Table' }).click();
  await page.getByRole('button', { name: /^Reading list/ }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('tab', { name: 'All books' }).click();
  await expect(page.getByRole('grid')).toBeVisible({ timeout: 30_000 });
  await installOverlay(page);
  await refresh(page);
  await caption(
    page,
    'The table, its class, its columns and its views: all RDF in NextGraph already.',
    2500,
  );

  for (const [index, [book, author]] of BOOKS.entries()) {
    // Header is row 1; column 1 is the row number, so name is 2, author 3.
    const row = index + 2;

    await cell(page, row, 2).click();
    await page.keyboard.type(book, { delay: 70 });
    await page.keyboard.press('Tab');
    await page.keyboard.type(author, { delay: 70 });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await refresh(page);
  }

  await caption(page, 'Three rows typed. Watching NextGraph...', 500);

  await expect
    .poll(
      async () => {
        await refresh(page);

        const found = await Promise.all(
          BOOKS.map(([book]) => subjectNamed(page, book)),
        );

        return found.every(subject => subject !== undefined);
      },
      { timeout: 90_000, intervals: [2000] },
    )
    .toBe(true);

  // In the document the row is a NextGraph subject; the write below targets
  // that. The app still knows the row by its Atomic subject, which is what the
  // read-back at the end asks the store for.
  const dune = (await subjectNamed(page, BOOKS[0][0]))!;
  expect(dune).toMatch(/^did:ng:o:[A-Za-z0-9_-]+:q:[A-Za-z0-9_-]{44}$/);
  const duneLocally = await atomicSubjectOf(page, dune);

  await caption(
    page,
    'Every row is a subject in the NextGraph document - ordinary RDF, no translation layer.',
    3500,
  );

  // 4 · And a write there comes back into the table ------------------------
  await caption(
    page,
    `Now writing into NextGraph directly, from outside: "Dune" becomes "${FROM_NEXTGRAPH}"...`,
    2500,
  );

  await page.evaluate(
    async ([subject, name, value]) => {
      const bridge = (
        window as unknown as {
          __ngBridge: {
            graph: string;
            transport: { update: (sparql: string) => Promise<void> };
          };
        }
      ).__ngBridge;

      await bridge.transport.update(
        `DELETE { GRAPH <${bridge.graph}> { <${subject}> <${name}> ?o } }
         WHERE { GRAPH <${bridge.graph}> { <${subject}> <${name}> ?o } };
         INSERT DATA { GRAPH <${bridge.graph}> { <${subject}> <${name}> "${value}" } }`,
      );
    },
    [dune, NAME, FROM_NEXTGRAPH],
  );

  // Nothing below touches the app's store: it has to notice on its own, and
  // the grid has to repaint from it.
  await expect
    .poll(
      async () => {
        await refresh(page);

        return nameOf(page, duneLocally);
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe(FROM_NEXTGRAPH);
  await expect(
    page.getByRole('gridcell', { name: FROM_NEXTGRAPH, exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  await caption(
    page,
    'The table picked it up. Two-way, live, no server in between.',
    4000,
  );
});
