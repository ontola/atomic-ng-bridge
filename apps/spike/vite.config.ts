import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

/**
 * `@ng-org/lib-wasm` is published as a wasm-pack *bundler* target: its entry
 * imports the `.wasm` file directly and calls `__wbindgen_start()` at module
 * scope (see NEXTGRAPH-ISSUES.md A6). That needs `vite-plugin-wasm`, plus an
 * `esnext` target so top-level await compiles without a second plugin.
 */
export default defineConfig({
  plugins: [wasm()],
  server: { port: 5190 },
  build: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@ng-org/lib-wasm'],
    esbuildOptions: { target: 'esnext' },
  },
});
