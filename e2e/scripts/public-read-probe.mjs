/**
 * Can a NextGraph document be read without a wallet?
 *
 * Two browser contexts against the local broker. A creates a wallet, a
 * document and one triple. B, with no wallet at all, tries every read the web
 * SDK exposes. Then B creates its own wallet and tries again with a session
 * that is not the author's. Every result is printed as-is.
 *
 *   node e2e/scripts/public-read-probe.mjs
 *
 * Needs the spike dev server on :5190 and the broker on :14400.
 */

import { chromium } from '@playwright/test';

const SPIKE = 'http://localhost:5190/?bootstrap=http://localhost:14400/.ng_bootstrap';

const browser = await chromium.launch();
const out = [];
const say = (label, value) => {
  out.push([label, value]);
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
};

const waitLog = (page, text) =>
  page.waitForFunction(
    t => document.querySelector('#log')?.textContent?.includes(t),
    text,
    { timeout: 60_000 },
  );

// --- A: author -----------------------------------------------------------
const a = await (await browser.newContext()).newPage();
await a.goto(SPIKE);
await a.waitForFunction(() => typeof window.ng?.sparql_query === 'function');
await a.click('#public');
await waitLog(a, 'session started');
await a.click('#connect');
await waitLog(a, 'connected to broker');
await a.click('#write');
await waitLog(a, 'wrote one triple');
const nuri = await a.evaluate(() => window.__spike.graph);
const sessionA = await a.evaluate(() => window.__spike.session.sessionId);
say('A document nuri', nuri);
const own = await a.evaluate(
  async ([s, g]) =>
    JSON.stringify(
      (await window.ng.sparql_query(s, `SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`, undefined, g))
        .results?.bindings?.length,
    ),
  [sessionA, nuri],
);
say('A reads own document, bindings', own);
const header = await a
  .evaluate(async ([s, g]) => JSON.stringify(await window.ng.fetch_header(s, g)), [sessionA, nuri])
  .catch(e => `ERROR ${e.message}`);
say('A fetch_header(own)', header);

// --- B: nobody ------------------------------------------------------------
const b = await (await browser.newContext()).newPage();
await b.goto(SPIKE);
await b.waitForFunction(() => typeof window.ng?.sparql_query === 'function');

const tryB = async (label, fn) => {
  const result = await b
    .evaluate(fn, nuri)
    .then(v => `OK ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 300))
    .catch(e => `ERROR ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
  say(label, result);
};

await tryB('B (no wallet) sparql_query(undefined session)', async g =>
  JSON.stringify(await window.ng.sparql_query(undefined, `SELECT ?s WHERE { GRAPH <${g}> { ?s ?p ?o } }`, undefined, g)),
);
await tryB('B (no wallet) fetch_header(undefined session)', async g =>
  JSON.stringify(await window.ng.fetch_header(undefined, g)),
);
await tryB('B (no wallet) app_request(doc_fetch_repo_subscribe)', async g => {
  const req = await window.ng.doc_fetch_repo_subscribe(g);
  return JSON.stringify(await window.ng.app_request(req));
});
await tryB('B (no wallet) app_request_stream(doc_fetch_repo_subscribe)', async g => {
  const req = await window.ng.doc_fetch_repo_subscribe(g);
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('no response in 8s'), 8000);
    window.ng
      .app_request_stream(req, r => {
        clearTimeout(t);
        resolve(JSON.stringify(r).slice(0, 300));
      })
      .catch(e => {
        clearTimeout(t);
        reject(e);
      });
  });
});

// --- B: a different wallet ----------------------------------------------
await b.click('#public');
await waitLog(b, 'session started');
await b.click('#connect');
await waitLog(b, 'connected to broker');
const sessionB = await b.evaluate(() => window.__spike.session.sessionId);
say('B has its own session', sessionB !== undefined);

const tryB2 = async (label, fn) => {
  const result = await b
    .evaluate(fn, [sessionB, nuri])
    .then(v => `OK ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 300))
    .catch(e => `ERROR ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
  say(label, result);
};

await tryB2('B (other wallet) sparql_query on A document', async ([s, g]) =>
  JSON.stringify(
    (await window.ng.sparql_query(s, `SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`, undefined, g)).results?.bindings,
  ),
);
await tryB2('B (other wallet) fetch_header on A document', async ([s, g]) =>
  JSON.stringify(await window.ng.fetch_header(s, g)),
);
await tryB2('B (other wallet) app_request_stream(doc_fetch_repo_subscribe) with session', async ([s, g]) => {
  const req = await window.ng.doc_fetch_repo_subscribe(g);
  req.V0.session_id = s;
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('no response in 8s'), 8000);
    window.ng
      .app_request_stream(req, r => {
        clearTimeout(t);
        resolve(JSON.stringify(r).slice(0, 300));
      })
      .catch(e => {
        clearTimeout(t);
        reject(e);
      });
  });
});

await browser.close();
console.log('\nRESULTS');
for (const [k, v] of out) console.log(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
