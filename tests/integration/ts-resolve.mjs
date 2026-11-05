/**
 * Lets `node --test` load the app's TypeScript sources unchanged.
 *
 * Node 24 strips types from .ts files on its own, but it still applies strict
 * ESM resolution, which requires a file extension on every relative import.
 * The app's own modules use extensionless imports, as is normal for a bundled
 * project, so this hook retries a failed relative resolution with `.ts`.
 *
 * Preferred over rewriting every import in src/ to carry a `.ts` suffix: the
 * cost of running these tests should not leak into the shape of the
 * application code.
 *
 * Used as: node --import ./tests/integration/ts-resolve.mjs --test <file>
 */

import { registerHooks } from 'node:module';

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && !HAS_EXTENSION.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          // Fall through to the original, more informative error.
        }
      }
      throw err;
    }
  },
});
