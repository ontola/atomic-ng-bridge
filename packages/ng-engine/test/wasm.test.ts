import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_WASM_METHODS,
  WasmSkewError,
  probeWasmMethods,
} from '../src/index.js';

describe('the boot probe', () => {
  const complete = Object.fromEntries(
    REQUIRED_WASM_METHODS.map(name => [name, () => undefined]),
  );

  it('passes when every method is present', () => {
    expect(() => probeWasmMethods(complete)).not.toThrow();
  });

  it('names every missing method, so skew fails loudly at boot', () => {
    const { sparql_update: _dropped, doc_create: _also, ...partial } = complete;

    try {
      probeWasmMethods(partial);
      expect.unreachable('probe should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WasmSkewError);
      expect((error as WasmSkewError).missing.sort()).toEqual([
        'doc_create',
        'sparql_update',
      ]);
      expect((error as Error).message).toContain('A4');
    }
  });

  it('rejects a method that exists but is not callable', () => {
    expect(() =>
      probeWasmMethods({ ...complete, sparql_query: 'not a function' }),
    ).toThrow(WasmSkewError);
  });
});

describe('the installed @ng-org/lib-wasm', () => {
  /**
   * Static half of the same check, and the half that runs in CI: the wasm
   * itself needs a browser, but its typings do not. A dependency bump that
   * renames a method (the documented silent-failure mode, `NEXTGRAPH-ISSUES.md`
   * A4) fails here rather than in front of a user.
   */
  it('declares every method this package calls', () => {
    const require = createRequire(import.meta.url);
    const typings = readFileSync(
      require.resolve('@ng-org/lib-wasm/lib_wasm.d.ts'),
      'utf8',
    );

    const missing = REQUIRED_WASM_METHODS.filter(
      name => !new RegExp(`export function ${name}\\(`).test(typings),
    );

    expect(missing).toEqual([]);
  });
});
