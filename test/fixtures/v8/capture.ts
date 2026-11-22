// Writes this directory's fixtures: the traced run of `bench.ts`, as
// `--v8-report` makes it, on the Node that runs this script. Run it with
// `node --no-strip-types --import @snovader/node-hooks/register
// test/fixtures/v8/capture.ts` on each version of Node that the parsers are
// checked against. It writes `node-<version>.trace.txt` and
// `node-<version>.code.log`, as `captured-run.ts` describes.
import { join } from 'node:path';
import { captureTracedRun } from './captured-run.ts';

await captureTracedRun(
    join(import.meta.dirname, 'bench.ts'),
    import.meta.dirname
);
