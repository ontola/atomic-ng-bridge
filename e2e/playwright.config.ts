import { defineConfig } from '@playwright/test';

/**
 * The demo, recorded.
 *
 * Headed-quality video of one test that proves the claim end to end: an Atomic
 * app with no AtomicServer, its data landing in a real NextGraph document, and
 * a NextGraph-side write coming back the other way.
 *
 * The app under test is `atomic-server`'s data-browser on the `feat/ng-bridge`
 * branch, which is where the one-line integration lives. It has to be running
 * already: its dev server needs wasm assets that are built out-of-band, so
 * starting it here would hide a failure that is not this test's to report.
 */
export default defineConfig({
  testDir: './tests',
  // One worker: the bridge creates a wallet on a public broker, and parallel
  // runs would race for the same document.
  workers: 1,
  // Wallet creation and the first NextGraph sync are slow, and this test is a
  // narrated sequence rather than a unit check.
  timeout: 3 * 60 * 1000,
  expect: { timeout: 60 * 1000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.DEMO_URL ?? 'http://localhost:6750',
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // Slow the driver down: this recording is for people to watch, and
    // instantaneous automation reads as a cut rather than a demonstration.
    launchOptions: { slowMo: 250 },
  },
  outputDir: './artifacts',
});
