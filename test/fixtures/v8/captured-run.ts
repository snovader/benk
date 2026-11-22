// Writes the fixtures of a traced run, as `--v8-report` makes it, on the Node
// that runs the script that calls it, or on the d8 on the PATH:
// `capture.ts`, of `bench.ts`, `bundled/capture.ts`, of a bundle, and
// `d8/capture.ts`, of a bundle in d8.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    runTraced,
    runTracedInD8,
    type TracedOutput
} from '#source/node/traced-run';
import { parseLoggedVersion } from '#source/node/v8-trace';

const REPOSITORY = join(import.meta.dirname, '..', '..', '..');

/**
 * Runs a script with V8's traces on this Node, and writes the fixtures of
 * the run, `node-<version>.trace.txt` and `node-<version>.code.log`, into a
 * directory, as `writeTracedRun()` writes them
 */
export async function captureTracedRun(
    script: string,
    directory: string
): Promise<void> {
    const traced = await runTraced(script, []);

    await writeTracedRun(
        traced,
        join(directory, `node-${process.versions.node}`)
    );
}

/**
 * Runs a script with V8's traces on the d8 on the PATH, as `benk-d8` does,
 * and writes the fixtures of the run, `d8-<version>.trace.txt` and
 * `d8-<version>.code.log`, into a directory, as `writeTracedRun()` writes
 * them, with d8's version from the code log
 *
 * @throws {Error} If the code log has no version.
 */
export async function captureTracedRunInD8(
    script: string,
    directory: string
): Promise<void> {
    const traced = await runTracedInD8({
        d8: 'd8',
        flags: [],
        script,
        args: []
    });
    const version = parseLoggedVersion(traced.codeLog);
    if (version == null) {
        throw new Error("Expected d8's version in the code log, got none");
    }

    await writeTracedRun(traced, join(directory, `d8-${version}`));
}

/**
 * Writes `<prefix>.trace.txt`, a traced run's stdout, and
 * `<prefix>.code.log`, the lines of its code log that name a function that
 * the traces name. Both have the repository's directory replaced by
 * `/benk`, so that they don't depend on where it's checked out.
 */
async function writeTracedRun(
    { output, codeLog }: TracedOutput,
    prefix: string
): Promise<void> {
    const named = namedAddresses(output);
    const logged = codeLog
        .split('\n')
        .filter(line => line.startsWith('v8-version,') || namesOne(line, named))
        .join('\n');

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
