/**
 * `NgTransport` over the embedded engine.
 *
 * This is the ~50 lines that the unpublished `@ng-org/api-web` would have given
 * us (`NEXTGRAPH-ISSUES.md` A3), plus the boot probe A4 makes necessary. It is
 * the only implementation of the transport seam; everything above it is
 * engine-agnostic, so if M0 forces the iframe path instead, this file is what
 * gets replaced.
 */

import type { NgSubscription, NgTransport, Triple } from '@tomic/ng-bridge';
import { bindingsToTriples, bindingsToValues } from './results.js';
import { probeWasmMethods, type NgWasm } from './wasm.js';

export type NgTransportOptions = {
  ng: NgWasm;
  sessionId: unknown;
  /** The document this transport reads and writes: `did:ng:<docId>`. */
  graph: string;
  /** Skip the boot probe. Only for tests with a stub. */
  skipProbe?: boolean;
};

export type NgEngineTransport = NgTransport & {
  /** The document nuri this transport is bound to. */
  readonly graph: string;
  /** Runs a query and reads one variable out of it. */
  queryValues: (sparql: string, variable: string) => Promise<string[]>;
  /** Reads every triple of one subject. */
  querySubject: (subject: string, sparql: string) => Promise<Triple[]>;
};

export function createNgTransport(
  options: NgTransportOptions,
): NgEngineTransport {
  const { ng, sessionId, graph, skipProbe = false } = options;

  if (!skipProbe) {
    probeWasmMethods(ng);
  }

  let subscription: { close?: () => void } | undefined;

  return {
    graph,

    query: async (sparql: string): Promise<Triple[]> => {
      // Subject-less queries are read through `queryValues`; this overload
      // exists for callers that already know the subject, so the generic
      // version returns the bindings of `?s ?p ?o` shaped queries only.
      const raw = await ng.sparql_query(sessionId, sparql, undefined, graph);

      return bindingsToTriples('', raw);
    },

    querySubject: async (subject, sparql) => {
      const raw = await ng.sparql_query(sessionId, sparql, undefined, graph);

      return bindingsToTriples(subject, raw);
    },

    queryValues: async (sparql, variable) => {
      const raw = await ng.sparql_query(sessionId, sparql, undefined, graph);

      return bindingsToValues(raw, variable);
    },

    update: async (sparql: string): Promise<void> => {
      await ng.sparql_update(sessionId, sparql, graph);
    },

    subscribe: async (callback: () => void): Promise<NgSubscription> => {
      const handle = (await ng.doc_subscribe(graph, sessionId, () =>
        callback(),
      )) as { close?: () => void } | undefined;

      subscription = handle ?? undefined;

      return {
        close: () => {
          subscription?.close?.();
          subscription = undefined;
        },
      };
    },

    close: async (): Promise<void> => {
      subscription?.close?.();
      subscription = undefined;
    },
  };
}
