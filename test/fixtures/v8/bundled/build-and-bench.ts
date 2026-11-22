// Bundles `bench.ts` with a source map into a temporary directory, runs the
// bundle, and deletes it once `bench()` returns, as a build that times its
// bundle may do. The traced run of `--v8-report` runs this script too, and
// deletes its own bundle before the process that reports it reads its
// traces.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

// Its real path, by which Node names the bundle's module, so that the
// sources that rolldown names relative to it resolve, as macOS's temporary
// directory is under a symbolic link, /var
const directory = await realpath(await mkdtemp(join(tmpdir(), 'benk-')));
const file = join(directory, 'bench.mjs');

// benk stays an import, by the URL that it resolves to here, as the bundle
// is outside the repository
const bundle = await rolldown({
    input: join(import.meta.dirname, 'bench.ts'),
    external: [/^benk(?:\/|$)/],
    platform: 'node'
});
try {
    await bundle.write({
        file,
        format: 'esm',
        sourcemap: true,
        paths: { benk: import.meta.resolve('benk') }
    });
} finally {
    await bundle.close();
}

try {
    await import(pathToFileURL(file).href);
} finally {
    await rm(directory, { recursive: true });
}
