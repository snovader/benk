// Writes this directory's fixtures: `bench.mjs`, the bundle of `bench.ts`
// and `sum.ts`, with its source map, `bench.mjs.map`, and the traced run of
// the bundle, as `--v8-report` makes it, on the Node that runs this script.
// Run it with `node --no-strip-types --import @snovader/node-hooks/register
// test/fixtures/v8/bundled/capture.ts`. It writes `node-<version>.trace.txt`
// and `node-<version>.code.log`, as `captured-run.ts` describes.
import { join } from 'node:path';
import { rolldown } from 'rolldown';
import { captureTracedRun } from '#test/fixtures/v8/captured-run';

const BUNDLE = join(import.meta.dirname, 'bench.mjs');

// benk stays an import, as the harness rather than the code that it times
const bundle = await rolldown({
    input: join(import.meta.dirname, 'bench.ts'),
    external: [/^benk(?:\/|$)/],
    platform: 'node'
});
try {
    await bundle.write({ file: BUNDLE, format: 'esm', sourcemap: true });
} finally {
    await bundle.close();
}

await captureTracedRun(BUNDLE, import.meta.dirname);
