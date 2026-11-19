import { join } from 'node:path';
import { defineConfig } from 'rolldown';

/**
 * Bundles the package's entry point into one module in `dist/`, as it's
 * published. The package has no dependencies, so the bundle imports only
 * Node's modules. tsc writes the declarations beside it, with
 * `tsconfig.dist.json`.
 */
export default defineConfig({
    input: {
        index: join(import.meta.dirname, 'source/index.ts')
    },
    platform: 'node',
    output: {
        dir: join(import.meta.dirname, 'dist'),
        format: 'esm',
        // Empties it first, as `rm -rf dist` would, which Yarn's shell runs
        // from the system, and Windows doesn't have
        cleanDir: true
    }
});
