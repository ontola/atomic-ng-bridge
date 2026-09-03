/**
 * Constructing the engine worker, from inside the package that owns it.
 *
 * The URL is resolved relative to *this* module rather than the host app's,
 * which is the only way a consumer can spawn it without knowing how this
 * package is laid out on disk. Vite compiles `new Worker(new URL(…,
 * import.meta.url), { type: 'module' })` into a worker bundle, and because this
 * package ships TypeScript sources the host's own pipeline is what builds it.
 *
 * The one configuration cost this imposes on the host: `vite-plugin-wasm` has
 * to apply to worker builds as well as the main one (`worker.plugins`), because
 * the worker is what imports the NextGraph wasm now.
 *
 * `Worker` is referenced only inside the function, so importing this module in
 * a non-browser context (a test runner, SSR) is safe.
 */

export function spawnEngineWorker(): Worker {
  return new Worker(new URL('./engineWorker.ts', import.meta.url), {
    type: 'module',
    name: 'nextgraph-engine',
  });
}
