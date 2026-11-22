// Writes this directory's fixtures: `bench.mjs`, the bundle of
// `../bench.ts` for d8, with its source map, `bench.mjs.map`, and the traced
// run of the bundle in d8, as `benk-d8` makes it for `--v8-report`, on the
// d8 on the PATH. Run it with `node --no-strip-types --import
// @snovader/node-hooks/register test/fixtures/v8/d8/capture.ts` on each
// version of d8 that the parsers are checked against. It writes
// `d8-<version>.trace.txt` and `d8-<version>.code.log`, as
// `captured-run.ts` describes.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { captureTracedRunInD8 } from '#test/fixtures/v8/captured-run';

const BUNDLE = join(import.meta.dirname, 'bench.mjs');

// d8 reads an import as a path, so the bundle has benk in it: `benk/d8`'s
// source, for the `benk` that `bench.ts` imports, as `benk-d8` runs a
// script with `benk/d8`'s `bench()`. Without comments, and without the
// sources' text in the map, the bundle and its map are smaller, and the
// report needs neither.
const bundle = await rolldown({
    input: join(import.meta.dirname, '..', 'bench.ts'),
    platform: 'neutral',
    resolve: { alias: { benk: fileURLToPath(import.meta.resolve('benk/d8')) } }
});
try {
    await bundle.write({
        file: BUNDLE,
        format: 'esm',
        sourcemap: true,
        sourcemapExcludeSources: true,
        comments: false
    });
} finally {
    await bundle.close();
}

await captureTracedRunInD8(BUNDLE, import.meta.dirname);
