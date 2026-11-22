// Writes the fixtures of a traced run, as `--v8-report` makes it, on the Node
// that runs the script that calls it: `capture.ts`, of `bench.ts`, and
// `bundled/capture.ts`, of a bundle.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTraced } from '#source/node/traced-run';

const REPOSITORY = join(import.meta.dirname, '..', '..', '..');

/**
 * Runs a script with V8's traces, and writes `node-<version>.trace.txt`, the
 * run's stdout, and `node-<version>.code.log`, the lines of the code log
 * that name a function that the traces name, into a directory. Both have the
 * repository's directory replaced by `/benk`, so that they don't depend on
 * where it's checked out.
 */
export async function captureTracedRun(
    script: string,
    directory: string
): Promise<void> {
    const { output, codeLog } = await runTraced(script, []);
    const named = namedAddresses(output);

    const logged = codeLog
        .split('\n')
        .filter(line => line.startsWith('v8-version,') || namesOne(line, named))
        .join('\n');

    const prefix = join(directory, `node-${process.versions.node}`);
    await writeFile(`${prefix}.trace.txt`, anonymize(output));
    await writeFile(`${prefix}.code.log`, `${anonymize(logged)}\n`);
}

/** The addresses that the traces name, untagged, as the log has them */
function namedAddresses(output: string): Set<string> {
    return new Set(
        Array.from(
            output.matchAll(/(?:sfi = |\{)(?:0x)?([\dA-Fa-f]+)/g),
            ([, address]) => (BigInt(`0x${address}`) & ~3n).toString(16)
        )
    );
}

/** Whether a line of the log names one of the addresses */
function namesOne(line: string, named: ReadonlySet<string>): boolean {
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
