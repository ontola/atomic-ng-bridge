/**
 * M0: prove the engine, from a plain browser tab.
 *
 * Answers, in order:
 *   1. Can we drive `@ng-org/lib-wasm` ourselves, with no hosted wallet page
 *      and no iframe? (PLAN.md section 4's architecture decision rests on it.)
 *   2. Does `sparql_update` accept `;`-separated operations?
 *      (`NEXTGRAPH-ISSUES.md` C2, still unverified.)
 *   3. Does written data come back after a reload *without* a broker?
 *      (`NEXTGRAPH-ISSUES.md` B1 says no, from source. This is the empirical
 *      check, and the one to run before repeating either answer publicly.)
 *
 * Every step prints what it did and what came back, so the log can be pasted
 * straight into NEXTGRAPH-ISSUES.md as evidence.
 */

import * as ng from '@ng-org/lib-wasm';
import {
  contentHash,
  insertTriplesUpdate,
  replaceSubjectSteps,
  resourceToTriples,
  selectSubjectQuery,
  triplesToPropVals,
  AtomicDatatype,
} from '@tomic/ng-bridge';
import {
  connectUser,
  createNgTransport,
  createWalletFromInvitation,
  findOrCreateDocument,
  installNgStorageBridge,
  openWalletAndStartSession,
  probeWasmMethods,
  type NgSession,
  type NgWasm,
} from '@tomic/ng-engine';

const APP_CLASS = 'did:ng:z:AtomicNgBridgeSpike';
const DOC_KEY = 'ng-spike:document';
const SUBJECT = 'did:ad:resource:spike-1';
const NAME_PROPERTY = 'https://atomicdata.dev/properties/name';

const wasm = ng as unknown as NgWasm;
const logElement = document.querySelector<HTMLDivElement>('#log')!;

// The wasm services all of its storage through postMessage and hangs forever if
// nobody answers (NEXTGRAPH-ISSUES.md A7). This has to be installed before the
// first SDK call of any kind.
installNgStorageBridge();

// Exposed for diagnostics: this page is a harness, and being able to poke the
// engine from the console (or an automation driver) is the point of it.
(window as unknown as { ng: NgWasm }).ng = wasm;

let session: NgSession | undefined;
let graph: string | undefined = localStorage.getItem(DOC_KEY) ?? undefined;
let connected = false;

const log = (message: string, detail?: unknown) => {
  const rendered =
    detail === undefined
      ? message
      : `${message}\n  ${JSON.stringify(detail, null, 2).split('\n').join('\n  ')}`;
  logElement.textContent = `${logElement.textContent}\n${rendered}`;
  logElement.scrollTop = logElement.scrollHeight;
};

const clear = () => {
  logElement.textContent = '';
};

const failed = (step: string, error: unknown) => {
  log(`FAIL  ${step}`, error instanceof Error ? error.message : String(error));
};

const requireSession = (): NgSession => {
  if (session === undefined) {
    throw new Error('Open the wallet first.');
  }

  return session;
};

const transport = () =>
  createNgTransport({
    ng: wasm,
    sessionId: requireSession().sessionId,
    graph: graph ?? '',
  });

const on = (id: string, handler: () => Promise<void>) => {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.addEventListener(
    'click',
    () => {
      handler().catch(error => failed(id, error));
    },
  );
};

// ---------------------------------------------------------------- 1 · session

on('open', async () => {
  clear();
  log('probe: does the loaded wasm export everything we call?');
  probeWasmMethods(wasm);
  log('  ok — no version skew (NEXTGRAPH-ISSUES.md A4)');

  const input = document.querySelector<HTMLInputElement>('#wallet')!;
  const file = input.files?.[0];

  if (file === undefined) {
    throw new Error('Choose a wallet file.');
  }

  const password =
    document.querySelector<HTMLInputElement>('#password')!.value;

  log(`opening wallet ${file.name} (${file.size} bytes), in memory`);
  session = await openWalletAndStartSession({
    ng: wasm,
    walletFile: new Uint8Array(await file.arrayBuffer()),
    password,
    inMemory: true,
  });

  log('session started with no hosted wallet page and no iframe', {
    walletName: session.walletName,
    userId: session.userId,
    privateStoreId: session.privateStoreId,
    sessionId: session.sessionId,
  });
  log('=> M0 question 1: the embedded-engine path works in a plain tab.');
});

on('create', async () => {
  clear();
  log('probe: does the loaded wasm export everything we call?');
  probeWasmMethods(wasm);
  log('  ok — no version skew (NEXTGRAPH-ISSUES.md A4)');

  const invitation =
    document.querySelector<HTMLInputElement>('#invite')!.value.trim();

  if (invitation === '') {
    throw new Error('Paste a broker invitation link.');
  }

  const password =
    document.querySelector<HTMLInputElement>('#password')!.value || 'spike-pass';

  log('creating a wallet from the invitation, in memory, no wallet UI');
  const created = await createWalletFromInvitation({
    ng: wasm,
    invitation,
    password,
  });

  session = created.session;
  log('session started with no hosted wallet page and no iframe', {
    walletName: session.walletName,
    userId: session.userId,
    privateStoreId: session.privateStoreId,
    sessionId: session.sessionId,
  });
  log('=> M0 question 1: the embedded-engine path works in a plain tab.');
});

/**
 * The public broker publishes its bootstrap at `https://nextgraph.eu/.ng_bootstrap`,
 * which is exactly what an invitation link decodes to. Fetched at runtime so
 * this is never a stale copy of someone else's infrastructure; the shape is
 * `{ V0: { bootstrap, registration_url } }`.
 */
const PUBLIC_BOOTSTRAP_URL = 'https://nextgraph.eu/.ng_bootstrap';

on('public', async () => {
  clear();
  log('probe: does the loaded wasm export everything we call?');
  probeWasmMethods(wasm);
  log('  ok — no version skew (NEXTGRAPH-ISSUES.md A4)');

  log(`fetching broker bootstrap from ${PUBLIC_BOOTSTRAP_URL}`);
  const response = await fetch(PUBLIC_BOOTSTRAP_URL);

  if (!response.ok) {
    throw new Error(`bootstrap fetch failed: ${response.status}`);
  }

  const bootstrap = (await response.json()) as {
    V0: { bootstrap: unknown; registration_url?: string };
  };

  log('got bootstrap', bootstrap.V0);

  const password =
    document.querySelector<HTMLInputElement>('#password')!.value || 'spike-pass';

  log('creating a throwaway wallet against the public broker, in memory');
  const created = await createWalletFromInvitation({
    ng: wasm,
    bootstrap: bootstrap.V0.bootstrap,
    password,
  });

  session = created.session;
  log('session started with no hosted wallet page and no iframe', {
    walletName: session.walletName,
    userId: session.userId,
    privateStoreId: session.privateStoreId,
    sessionId: session.sessionId,
  });
  log('=> M0 question 1: the embedded-engine path works in a plain tab.');
});

on('connect', async () => {
  const result = await connectUser(wasm, requireSession());
  connected = true;
  log('connected to broker', result);
});

// ------------------------------------------------------- 2 · write/read/multi

const ensureDocument = async (): Promise<string> => {
  if (graph !== undefined) {
    return graph;
  }

  const doc = await findOrCreateDocument(wasm, requireSession(), APP_CLASS);
  graph = doc.nuri;
  localStorage.setItem(DOC_KEY, doc.nuri);
  log(doc.created ? 'created document' : 'found existing document', doc.nuri);

  return doc.nuri;
};

on('write', async () => {
  const target = await ensureDocument();
  const triples = [
    {
      subject: SUBJECT,
      predicate: NAME_PROPERTY,
      object: {
        termType: 'literal' as const,
        value: `written at ${new Date().toISOString()}`,
      },
    },
  ];

  await transport().update(insertTriplesUpdate(target, triples));
  log('wrote one triple', { graph: target, broker: connected });
});

on('read', async () => {
  const target = await ensureDocument();
  const triples = await transport().querySubject(
    SUBJECT,
    selectSubjectQuery(target, SUBJECT),
  );

  log(`read back ${triples.length} triple(s)`, triples);
});

on('multi', async () => {
  const target = await ensureDocument();
  const steps = replaceSubjectSteps(
    target,
    SUBJECT,
    [
      {
        subject: SUBJECT,
        predicate: NAME_PROPERTY,
        object: { termType: 'literal', value: 'multi-op probe' },
      },
    ],
    { deleteOnlyPredicates: [NAME_PROPERTY] },
  );

  try {
    await transport().update(steps.join(';\n'));
    log('=> C2 ANSWERED: ;-separated updates ARE accepted. One commit per edit.');
  } catch (error) {
    log(
      '=> C2 ANSWERED: ;-separated updates are REJECTED. Two commits per edit,' +
        ' with a transient empty state between them.',
      error instanceof Error ? error.message : String(error),
    );
  }
});

on('roundtrip', async () => {
  const target = await ensureDocument();
  const propVals = {
    [NAME_PROPERTY]: 'Buy milk',
    'https://atomicdata.dev/properties/isA': [
      'https://atomicdata.dev/classes/Task',
    ],
  };
  const datatypeOf = (property: string) =>
    property === NAME_PROPERTY
      ? AtomicDatatype.STRING
      : AtomicDatatype.RESOURCEARRAY;

  const mapped = resourceToTriples(SUBJECT, propVals, { datatypeOf });
  const engine = transport();

  for (const step of replaceSubjectSteps(target, SUBJECT, mapped.triples, {
    deleteOnlyPredicates: mapped.triples.map(triple => triple.predicate),
  })) {
    await engine.update(step);
  }

  const readBack = await engine.querySubject(
    SUBJECT,
    selectSubjectQuery(target, SUBJECT),
  );
  const restored = triplesToPropVals(readBack, { datatypeOf });

  log('round trip through a real NextGraph document', {
    wrote: propVals,
    readBack: restored.propVals,
    hashMatches: contentHash(mapped.triples) === contentHash(readBack),
    warnings: restored.warnings,
  });
});

// ------------------------------------------------------------- 3 · after reload

on('readOffline', async () => {
  if (connected) {
    log(
      'NOTE: this session already connected to a broker, so this run cannot' +
        ' distinguish local persistence from broker delivery. Reload first.',
    );
  }

  const target = await ensureDocument();
  const triples = await transport().querySubject(
    SUBJECT,
    selectSubjectQuery(target, SUBJECT),
  );

  log(
    triples.length > 0
      ? '=> data came back WITHOUT a broker connection in this session.'
      : '=> nothing came back without a broker. Consistent with B1: the browser' +
          ' keeps no durable local graph.',
    triples,
  );
});

on('reset', async () => {
  localStorage.removeItem(DOC_KEY);
  graph = undefined;
  log('forgot the remembered document; the next step creates a fresh one.');
});
