// `bench()` of d8, the V8 shell: a benchmark script's run, with the options
// of Node's command line that d8 can carry out. d8 passes a script the
// arguments after `--` on its own command line, as `d8 bench.mjs -- --rounds
// 51`, in a global `arguments`, and prints and writes files with globals of
// its own.
import {
    measureAndPrint,
    parseOptions,
    type BenchOptions
} from '#source/core/command-line';
import { measureGroups } from '#source/core/measure';
import { formatJson } from '#source/core/report';
import type { Group, RunResult, Runtime } from '#source/core/types';
import { D8Runtime } from './runtime.ts';
import { D8_TRACED_RUN } from './traced-run.ts';

// The globals of d8 that `bench()` reads, which aren't in any of
// TypeScript's libraries

/** Prints its arguments to stdout, and a newline */
declare function print(...values: unknown[]): void;

/** Prints its arguments to stderr, and a newline */
declare function printErr(...values: unknown[]): void;

/** Writes its arguments to stdout, without a newline */
declare function write(...values: unknown[]): void;

/**
 * Reads the bytes of a file
 *
 * @throws {Error} If d8 can't read it.
 */
declare function readbuffer(path: string): ArrayBuffer;

/**
 * Writes text to a file as UTF-8, or the bytes of an `ArrayBuffer` as they
 * are
 *
 * @throws {Error} If d8 can't open it, without the path.
 */
declare function writeFile(path: string, data: string | ArrayBuffer): void;

/**
 * Runs a benchmark script in d8, as `benk`'s `bench()` does in Node: reads
 * its options from the script's arguments, prints a description of the run,
 * measures each group whose name matches the filter and prints its table,
 * and then writes the results as JSON, if the options ask for it. Last, it
 * calls the `after` option, with the `print` that printed the tables.
 *
 * What d8 can't do as Node does:
 *
 * - `--json <path>` writes the file with d8's `writeFile()`. d8 has no
 *   check of a directory, so `bench()` checks the path before it measures
 *   by writing the file: with the bytes that it has, or empty.
 * - `--v8-report` is an error, before it measures, as is `--v8-filter`,
 *   which implies it, and `--processes` of more than 1: d8 can't start the
 *   process that runs the script again. The command `benk-d8` runs a script
 *   in d8 from Node, and carries them out itself.
 * - `--v8-check` is an error too, as is `--v8-max-bytecode`, which implies
 *   it, in `benk-d8` as well: the check needs Node's traced run, which
 *   reads where each variant's `run` starts, and marks the timed rounds.
 * - A run counts bytes only with a runtime that counts them. `D8Runtime`
 *   counts array buffers only where d8 started with the flags that it
 *   describes, and never heap bytes. A run that counts neither records
 *   `heap: false`, with or without `--no-heap`, and its description leaves
 *   the bytes out.
 *
 * @throws {TypeError} If an argument isn't one of the options, or a group is
 * malformed, as `measureGroups()` describes.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 * @throws {Error} With `--processes` of more than 1, `--v8-report`,
 * `--v8-check` or an option that implies either, or if the JSON's file can't be
 * written, which it checks before it measures, if the runtime's clock reads
 * no time, if a variant throws, with its error as the cause, or if `after`
 * throws, with its error.
 */
export async function bench(
    groups: Iterable<Group>,
    options: BenchOptions = {}
): Promise<RunResult> {
    const {
        json,
        processes,
        v8Report,
        v8Filter,
        v8Check,
        v8MaxBytecode,
        ...command
    } = parseOptions(options.args ?? scriptArguments());
    if (processes > 1) {
        throw new Error(
            `Expected no --processes ${processes} in d8, which can't start a process: run it with benk-d8, as benk-d8 bench.mjs -- --processes ${processes}`
        );
    }
    if (v8Check) {
        const option =
            v8MaxBytecode == null ? '--v8-check' : '--v8-max-bytecode';
        throw new Error(
            `Expected no ${option} in d8, nor in benk-d8: V8's check needs Node's traced run, of a script that calls benk's bench()`
        );
    }
    if (v8Report) {
        throw new Error(
            `Expected no --v8-report${v8Filter == null ? '' : ' or --v8-filter'} in d8, which can't run the script again: run it with benk-d8, as benk-d8 bench.mjs -- --v8-report`
        );
    }
    const runtime = options.runtime ?? new D8Runtime();
    const run = { ...command, heap: command.heap && countsBytes(runtime) };
    if (Object.hasOwn(globalThis, Symbol.for(D8_TRACED_RUN))) {
        return measureGroups(groups, run, runtime);
    }

    const toStdout = json === '-';
    const printLine = options.print ?? (toStdout ? printErr : print);
    if (json != null && !toStdout) {
        checkFile(json);
    }

    const result = await measureAndPrint(groups, run, runtime, printLine);

    if (toStdout) {
        (options.write ?? write)(formatJson(result));
    } else if (json != null) {
        writeResults(json, formatJson(result));
    }

    await options.after?.(printLine, result);

    return result;
}

/**
 * The script's arguments, which d8 puts in a global `arguments`. Within a
 * function, `arguments` is the function's own, so this reads the global's.
 */
function scriptArguments(): readonly string[] {
    const shell = globalThis as { readonly arguments?: readonly string[] };

    return shell.arguments ?? [];
}

/** Whether a runtime counts any of the bytes that calls allocate */
function countsBytes(runtime: Runtime): boolean {
    return runtime.heap != null || runtime.arrayBuffers != null;
}

/**
 * Checks that d8 can write the results' file, before the run rather than
 * after it, when a mistyped path would lose the measurements. d8 can't ask
 * whether a directory can be written to, so this writes the file again with
 * the bytes that d8 reads of it, or empty if it reads none, as when it's
 * missing. It reads bytes rather than text: d8's `read()` decodes the file
 * as UTF-8, and takes each byte that isn't UTF-8 for U+FFFD.
 *
 * @throws {Error} If d8 can't write the file.
 */
function checkFile(path: string): void {
    let bytes = new ArrayBuffer(0);
    try {
        bytes = readbuffer(path);
    } catch {
        // A file that d8 can't read is written empty, if it can be written
    }

    writeResults(path, bytes);
}

/**
 * Writes the results' file, with text as UTF-8, or with bytes as they are
 *
 * @throws {Error} If d8 can't, with the path, which d8's error leaves out.
 */
function writeResults(path: string, data: string | ArrayBuffer): void {
    try {
        writeFile(path, data);
    } catch (error) {
        throw new Error(
            `Expected d8 to write the file of --json, got ${path}`,
            { cause: error }
        );
    }
}
