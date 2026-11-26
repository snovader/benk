// The results' JSON, as Node's `bench()` and benk-d8 write it for `--json`:
// to a file, whose directory they check before they measure, or to stdout
// for `-`.
import { access, constants, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { formatJson } from '#source/core/report';
import type { RunResult } from '#source/core/types';

/**
 * Checks that the directory of the results' file can be written to, before
 * the run rather than after it, when a mistyped path would lose the
 * measurements
 *
 * @throws {Error} If it can't.
 */
export async function checkDirectory(path: string): Promise<void> {
    const directory = dirname(resolve(path));
    try {
        await access(directory, constants.W_OK);
    } catch (error) {
        throw new Error(
            `Expected the directory of --json to be writable, got ${directory}`,
            { cause: error }
        );
    }
}

/**
 * Writes the results as JSON where `--json` says: with `write` for `-`, to
 * the file of a path, or nowhere without it
 */
export async function writeJson(
    json: string | undefined,
    result: RunResult,
    write: (text: string) => void
): Promise<void> {
    if (json === '-') {
        write(formatJson(result));
    } else if (json != null) {
        await writeFile(json, formatJson(result));
    }
}
