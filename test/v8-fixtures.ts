// The traced runs of `fixtures/v8/bench.ts`, which `fixtures/v8/capture.ts`
// captured on each version of Node, for the tests of the V8 report. The
// fixtures have the repository's directory replaced by `/benk`, which these
// put back as it's checked out, so that the scripts' URLs are of real files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    parseCodeLog,
    parseTrace,
    type FunctionAddress,
    type LoggedFunction,
    type V8Trace
} from '#source/node/v8-trace';

/** The versions of Node of the fixtures, with V8 13.6, 14.6 and 15.6 */
export const VERSIONS = ['24.22.3', '26.13.0', '27.0.0-alpha.0.0.0'] as const;

/** The repository's directory, as it's checked out */
export const REPOSITORY = join(import.meta.dirname, '..');

/** The path of the benchmark of the fixtures, from the repository's directory */
export const BENCH = join('test', 'fixtures', 'v8', 'bench.ts');

/** The URL of the benchmark of the fixtures */
export const BENCH_URL = pathToFileURL(join(REPOSITORY, BENCH)).href;

/** What a version's traced run wrote: its stdout, or its code log */
export function fixture(
    version: string,
    file: 'trace.txt' | 'code.log'
): string {
    const text = readFileSync(
        join(import.meta.dirname, 'fixtures', 'v8', `node-${version}.${file}`),
        'utf8'
    );

    return text.replaceAll(
        'file:///benk/',
        `${pathToFileURL(REPOSITORY).href}/`
    );
}

/** A version's traces and code log, parsed */
export function traced(version: string): {
    trace: V8Trace;
    logged: Map<FunctionAddress, LoggedFunction>;
} {
    return {
        trace: parseTrace(fixture(version, 'trace.txt')),
        logged: parseCodeLog(fixture(version, 'code.log'))
    };
}
