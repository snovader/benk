import { join } from 'node:path';
import { defineConfig } from 'rolldown';

/**
 * Bundles the package's entry points into `dist/`, as they're published:
 * `benk`'s, `benk/core`'s and `benk/d8`'s, with what they share in a chunk
 * of its own. The package has no dependencies, so `benk`'s bundle imports
 * only Node's modules, and the others none. tsc writes the declarations
 * beside them, with `tsconfig.dist.json`.
 */
export default defineConfig({
    input: {
        index: join(import.meta.dirname, 'source/index.ts'),
        core: join(import.meta.dirname, 'source/core.ts'),
        d8: join(import.meta.dirname, 'source/d8.ts')
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
