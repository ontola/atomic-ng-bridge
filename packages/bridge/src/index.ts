export * from './types.js';
export * from './vocab.js';
export * from './mapping.js';
export * from './sparql.js';
export * from './canonical.js';
export * from './ports.js';
export * from './push.js';
export * from './pull.js';
export * from './bridge.js';
export * from './cursor-idb.js';
export { bytesToBase64, base64ToBytes } from './base64.js';

// `./atomic` (atomic-store-source.ts, atomic-store-sink.ts) is deliberately NOT
// re-exported here. Those are the only modules that import `@tomic/lib`, which
// pulls in Loro's wasm.
// Keeping it behind its own entry point means a consumer of the mapping and
// sync core pays nothing for it, and keeps the "core depends on nothing"
// property honest at bundle time, not just on paper.
