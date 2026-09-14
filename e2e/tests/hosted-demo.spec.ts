import { expect, test, type Frame, type Page } from '@playwright/test';

/**
 * The demo through NextGraph's own hosted wallet, as a test.
 *
 * Same claims as `demo.spec.ts`, with one difference in who signs the user
 * in: NextGraph's wallet page does, in its third-party mode. The app hands
 * over to the wallet, the wallet opens and hands back a session, and the app
 * runs inside the wallet's frame from then on. Every step after the hand-over
 * therefore drives that frame, not the page.
 *
 * Needs NextGraph's dev-mode stack (`scripts/ng-hosted-up.sh`) and a wallet
 * registered on the local broker:
 *
 *   NG_WALLET_FILE       path to the `.ngw`
 *   NG_WALLET_PASSWORD   its password
 *   NG_PEER_ID           the broker's peer id (`docker logs ngd`, "PeerId of node")
 *   DEMO_URL             the host app, resolving `@ng-org/web` to the dev build
 */

const NAME = 'https://atomicdata.dev/properties/name';
const WALLET_ORIGIN = process.env.NG_REDIR_ORIGIN ?? 'http://localhost:1421';
const BROKER_PORT = Number(process.env.NG_BROKER_PORT ?? 14400);

const BOOKS: [string, string][] = [
  ['Dune', 'Frank Herbert'],
  ['Neuromancer', 'William Gibson'],
  ['Solaris', 'Stanislaw Lem'],
];
const FROM_NEXTGRAPH = 'Dune Messiah';

type Target = Page | Frame;

/** The panel the video is built around: both sides, side by side. */
async function installOverlay(target: Target): Promise<void> {
  await target.evaluate(() => {
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
      const drive = w.store?.getDrive();

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
        rows.map(name => `<span class="demo-hit">• ${name}</span>`).join('<br>');
    };
  });
}

/** A caption alone, for pages that are not the app (the wallet). */
async function installCaptionOnly(target: Target): Promise<void> {
  await target.evaluate(() => {
    if (document.querySelector('#demo-caption') !== null) {
      return;
    }

    const el = document.createElement('div');
    el.id = 'demo-caption';
    el.setAttribute(
      'style',
      'position:fixed;left:50%;bottom:2.5rem;transform:translateX(-50%);max-width:44rem;' +
        'z-index:99999;background:rgba(18,18,20,.94);color:#fff;border-radius:10px;' +
        'padding:.8rem 1.1rem;font:14px/1.5 ui-monospace,monospace;' +
        'box-shadow:0 8px 30px rgb(0 0 0 / 35%);',
    );
    document.body.appendChild(el);
    (window as unknown as { demoCaption: (t: string) => void }).demoCaption = (
      text: string,
    ) => {
      el.textContent = text;
    };
  });
}

const caption = async (target: Target, text: string, holdMs = 1800) => {
  await target
    .evaluate(
      ([message]) =>
        (window as unknown as { demoCaption: (t: string) => void }).demoCaption(
          message as string,
        ),
      [text],
    )
    .catch(() => undefined);
  await target.waitForTimeout(holdMs);
};

const refresh = (target: Target) =>
  target
    .evaluate(() =>
      (window as unknown as { demoRefresh: () => Promise<void> }).demoRefresh(),
    )
    .catch(() => undefined);

const subjectNamed = (target: Target, value: string): Promise<string | undefined> =>
  target.evaluate(async ([wanted]) => {
    const bridge = (
      window as unknown as {
        __ngBridge?: {
          graph: string;
          transport: { queryValues: (s: string, v: string) => Promise<string[]> };
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

const atomicSubjectOf = (target: Target, ngSubject: string): Promise<string> =>
  target.evaluate(async ([s]) => {
    const bridge = (
      window as unknown as {
        __ngBridge: {
          graph: string;
          transport: { queryValues: (q: string, v: string) => Promise<string[]> };
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

const cell = (target: Target, row: number, column: number) =>
  target.locator(`[aria-rowindex="${row}"] > [aria-colindex="${column}"]`);

const nameOf = (target: Target, subject: string): Promise<string | undefined> =>
  target.evaluate(
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

test('sign in on NextGraph\'s wallet page, then mirror a table both ways', async ({
  page,
  baseURL,
}) => {
  test.slow();

  const walletFile = process.env.NG_WALLET_FILE;
  const password = process.env.NG_WALLET_PASSWORD;
  const peerId = process.env.NG_PEER_ID;
  test.skip(
    !walletFile || !password || !peerId,
    'Needs NG_WALLET_FILE, NG_WALLET_PASSWORD and NG_PEER_ID.',
  );

  // The redirect page keeps a list of brokers and shows a login only for one
  // it knows. The wallet app registers a broker itself when a wallet is
  // imported there; here it is done up front, the way the wallet app does it.
  const payload = Buffer.from(
    JSON.stringify([{ peer_id: peerId, localhost: BROKER_PORT }]),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const register = await page.context().newPage();
  await register.goto(
    `${WALLET_ORIGIN}/bootstrap.html#/?b=${payload}&close=1&m=add&ab=${encodeURIComponent(
      `${WALLET_ORIGIN}/`,
    )}`,
  );
  await register.waitForTimeout(3000);
  await register.close().catch(() => undefined);

  // The app reports, correctly, that no AtomicServer answers: the dev config
  // points it at a port nothing listens on (scripts/demo-up.sh), which is the
  // claim. That toast is hidden in every frame from the first paint.
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent =
        'div[style*="z-index: 9999"][style*="inset: 16px"] { display: none; }';
      document.head.appendChild(style);
    };

    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });

  // 1 · The app hands over to the wallet at once ---------------------------
  await page.goto('/?ngbridge=1&ngengine=web');
  await page.waitForURL(url => url.origin === WALLET_ORIGIN, { timeout: 60_000 });
  await expect(page.getByText(/Opening Wallet for/)).toBeVisible({ timeout: 60_000 });
  await installCaptionOnly(page);
  await caption(
    page,
    'Atomic Tables, Forms and Kanban, with no AtomicServer. Opening the app sends you to NextGraph.',
    3000,
  );
  await caption(
    page,
    "This is NextGraph's own wallet page. The app never sees the wallet.",
    2500,
  );

  // 2 · The wallet opens and hands back a session --------------------------

  await page.getByRole('button', { name: /Login/ }).first().click();
  await page.locator('input[type=file]').first().setInputFiles(walletFile!);
  const pw = page.locator('input[type=password]').first();
  await expect(pw).toBeVisible({ timeout: 30_000 });
  await installCaptionOnly(page);
  await caption(page, 'A wallet file and its password. Nothing else exists to sign in with.', 1500);
  await pw.fill(password!);
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page.getByText(/Wallet opened for/)).toBeVisible({ timeout: 90_000 });
  // The wallet page's caption has done its job; from here the app's panel talks.
  await page.evaluate(() => document.querySelector('#demo-caption')?.remove());

  // From here the app lives in the wallet page's frame.
  const app = await (async (): Promise<Frame> => {
    for (let i = 0; i < 60; i++) {
      const found = page
        .frames()
        .find(f => f !== page.mainFrame() && f.url().startsWith(baseURL!));

      if (found) {
        return found;
      }

      await page.waitForTimeout(1000);
    }

    throw new Error('The app frame never appeared inside the wallet page.');
  })();

  await expect(app.getByText(/NextGraph: Live/).first()).toBeVisible({
    timeout: 180_000,
  });
  await installOverlay(app);
  await refresh(app);
  await caption(
    app,
    'Back in the app, inside the wallet. Session from NextGraph; workspace mirrored into a NextGraph document.',
    3000,
  );

  // 3 · A table, typed into here, shows up there ---------------------------
  await expect(app.getByTestId('editable-title')).toBeVisible({ timeout: 60_000 });
  await caption(app, 'Creating a table from a template...', 1200);

  await app.getByRole('main').getByRole('button', { name: 'New Table' }).click();
  await app.getByRole('button', { name: /^Reading list/ }).click();
  await app.getByRole('button', { name: 'Create', exact: true }).click();
  await app.getByRole('tab', { name: 'All books' }).click();
  await expect(app.getByRole('grid')).toBeVisible({ timeout: 30_000 });
  await installOverlay(app);
  await refresh(app);
  await caption(
    app,
    'The table, its class, its columns and its views: all RDF in NextGraph already.',
    2500,
  );

  for (const [index, [book, author]] of BOOKS.entries()) {
    const row = index + 2;

    await cell(app, row, 2).click();
    await page.keyboard.type(book, { delay: 70 });
    await page.keyboard.press('Tab');
    await page.keyboard.type(author, { delay: 70 });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await refresh(app);
  }

  await caption(app, 'Three rows typed. Watching NextGraph...', 500);

  await expect
    .poll(
      async () => {
        await refresh(app);
        const found = await Promise.all(BOOKS.map(([book]) => subjectNamed(app, book)));

        return found.every(subject => subject !== undefined);
      },
      { timeout: 90_000, intervals: [2000] },
    )
    .toBe(true);

  const dune = (await subjectNamed(app, BOOKS[0][0]))!;
  expect(dune).toMatch(/^did:ng:o:[A-Za-z0-9_-]+:q:[A-Za-z0-9_-]{44}$/);
  const duneLocally = await atomicSubjectOf(app, dune);

  await caption(
    app,
    'Every row is a subject in the NextGraph document - ordinary RDF, no translation layer.',
    3500,
  );

  // 4 · And a write there comes back into the table ------------------------
  await caption(
    app,
    `Now writing into NextGraph directly, from outside: "Dune" becomes "${FROM_NEXTGRAPH}"...`,
    2500,
  );

  await app.evaluate(
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

  await expect
    .poll(
      async () => {
        await refresh(app);

        return nameOf(app, duneLocally);
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe(FROM_NEXTGRAPH);
  await expect(app.getByRole('gridcell', { name: FROM_NEXTGRAPH, exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await caption(
    app,
    'The table picked it up. Two-way, live, signed in through NextGraph, no server in between.',
    4000,
  );
});
