/**
 * The `@tomic/lib`-facing adapters, behind their own entry point so the mapping
 * and sync core stay dependency-free at bundle time (see `index.ts`).
 */

export * from './atomic-store-source.js';
export * from './atomic-store-sink.js';
