// The traced runs of `fixtures/v8/bench.ts`, which `fixtures/v8/capture.ts`
// captured on each version of Node, of the bundle of `fixtures/v8/bundled`,
// which `fixtures/v8/bundled/capture.ts` captured, and of the bundle of
// `fixtures/v8/bench.ts` in d8, which `fixtures/v8/d8/capture.ts` captured,
// for the tests of the V8 report. The fixtures have the repository's
// directory replaced by `/benk`, which these put back as it's checked out,
// so that the scripts' URLs and paths are of real files.
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

/** The version of Node of the bundle's fixtures */
export const BUNDLED_VERSION = '26.13.0';

/** The version of d8 of the fixtures in d8, of V8 15.8 */
export const D8_VERSION = '15.8.62.9';

/** The repository's directory, as it's checked out */
export const REPOSITORY = join(import.meta.dirname, '..');

/** The path of the benchmark of the fixtures, from the repository's directory */
export const BENCH = join('test', 'fixtures', 'v8', 'bench.ts');

/** The URL of the benchmark of the fixtures */
export const BENCH_URL = pathToFileURL(join(REPOSITORY, BENCH)).href;

/** The directory of the bundled benchmark, from the repository's directory */
export const BUNDLED = join('test', 'fixtures', 'v8', 'bundled');

/** The path of the bundle, from the repository's directory */
export const BUNDLE = join(BUNDLED, 'bench.mjs');

/** The URL of the bundle */
export const BUNDLE_URL = pathToFileURL(join(REPOSITORY, BUNDLE)).href;

/** The path of the benchmark's bundle for d8, from the repository's directory */
export const D8_BUNDLE = join('test', 'fixtures', 'v8', 'd8', 'bench.mjs');

/** The URL of the bundle for d8 */
export const D8_BUNDLE_URL = pathToFileURL(join(REPOSITORY, D8_BUNDLE)).href;

/**
 * The traced run of the fixtures' benchmark, of the bundled one, or of the
 * benchmark's bundle in d8
 */
export type TracedScript = 'bench' | 'bundle' | 'd8';

/** The directory of each traced run's fixtures, in `fixtures` */
const DIRECTORIES: Readonly<Record<TracedScript, string>> = {
    bench: 'v8',
    bundle: join('v8', 'bundled'),
    d8: join('v8', 'd8')
};

/**
 * A path that d8 names a script by in the fixtures, as `</benk/test/…>` in
 * a position of the traces, and ` /benk/test/…` after a name in the log
 */
const D8_PATH = /(?<=[< ])\/benk\//g;

/**
 * What a version's traced run wrote: its stdout, or its code log. Node
 * names its scripts by their URLs, and d8 by their paths, which the log
 * escapes, as a Windows path's backslashes.
 */
export function fixture(
    version: string,
    file: 'trace.txt' | 'code.log',
    script: TracedScript = 'bench'
): string {
    const engine = script === 'd8' ? 'd8' : 'node';
    const text = readFileSync(
        join(
            import.meta.dirname,
            'fixtures',
            DIRECTORIES[script],
            `${engine}-${version}.${file}`
        ),
        'utf8'
    );
    const directory = file === 'code.log' ? escapeLog(REPOSITORY) : REPOSITORY;

    return text
        .replaceAll('file:///benk/', `${pathToFileURL(REPOSITORY).href}/`)
        .replaceAll(D8_PATH, () => `${directory}/`);
}

/** A string as V8's log writes it, with its backslashes and commas escaped */
export function escapeLog(text: string): string {
    return text.replaceAll('\\', '\\\\').replaceAll(',', '\\x2C');
}

/** A version's traces and code log, parsed */
export function traced(
    version: string,
    script: TracedScript = 'bench'
): {
    trace: V8Trace;
    logged: Map<FunctionAddress, LoggedFunction>;
} {
    return {
        trace: parseTrace(fixture(version, 'trace.txt', script)),
        logged: parseCodeLog(fixture(version, 'code.log', script))
    };
}

/**
 * A fixture's traces as V8 prints them on Windows: where V8 prints an address
 * with the C library's `%p`, or as a stream's `void*`, the Microsoft runtime
 * writes 16 digits in upper case without `0x`, and lines can end in `\r\n`.
 * The addresses that V8 formats itself, padded after `0x`, stay as they are.
 */
export function asOnWindows(trace: string): string {
    const pointer = (hex: string): string =>
        hex.toUpperCase().padStart(16, '0');

    return trace
        .replaceAll(
            /\(sfi = 0x([\da-f]+)\)/g,
            (_, hex: string) => `(sfi = ${pointer(hex)})`
        )
        .replaceAll(/0x([\da-f]+) \{/g, (_, hex: string) => `${pointer(hex)} {`)
        .replaceAll('\n', '\r\n');
}
