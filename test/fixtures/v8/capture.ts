// Writes this directory's fixtures: the traced run of `bench.ts`, as
// `--v8-report` makes it, on the Node that runs this script. Run it with
// `node --no-strip-types --import @snovader/node-hooks/register
// test/fixtures/v8/capture.ts` on each version of Node that the parsers are
// checked against. It writes `node-<version>.trace.txt`, the run's stdout,
// and `node-<version>.code.log`, the lines of the code log that name a
// function that the traces name. Both have the repository's directory
// replaced by `/benk`, so that they don't depend on where it's checked out.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTraced } from '#source/node/traced-run';

const REPOSITORY = join(import.meta.dirname, '..', '..', '..');

const { output, codeLog } = await runTraced(
    join(import.meta.dirname, 'bench.ts'),
    []
);

/** The addresses that the traces name, untagged, as the log has them */
const named = new Set(
    Array.from(
        output.matchAll(/(?:sfi = |\{)(?:0x)?([\dA-Fa-f]+)/g),
        ([, address]) => (BigInt(`0x${address}`) & ~3n).toString(16)
    )
);

const logged = codeLog
    .split('\n')
    .filter(line => line.startsWith('v8-version,') || namesOne(line))
    .join('\n');

const prefix = join(import.meta.dirname, `node-${process.versions.node}`);
await writeFile(`${prefix}.trace.txt`, anonymize(output));
await writeFile(`${prefix}.code.log`, `${anonymize(logged)}\n`);

/** Whether a line of the log names one of the addresses */
function namesOne(line: string): boolean {
    return Array.from(line.matchAll(/0x([\da-f]+)/g)).some(([, address]) =>
        named.has(BigInt(`0x${address}`).toString(16))
    );
}

/** The text with the repository's directory replaced by `/benk` */
function anonymize(text: string): string {
    return text
        .replaceAll(pathToFileURL(REPOSITORY).href, 'file:///benk')
        .replaceAll(REPOSITORY, '/benk');
}
