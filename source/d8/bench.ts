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
import { formatJson } from '#source/core/report';
import type { Group, RunResult, Runtime } from '#source/core/types';
import { D8Runtime } from './runtime.ts';

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
 * and then writes the results as JSON, if the options ask for it.
 *
 * What d8 can't do as Node does:
 *
 * - `--json <path>` writes the file with d8's `writeFile()`. d8 has no
 *   check of a directory, so `bench()` checks the path before it measures
 *   by writing the file: with the bytes that it has, or empty.
 * - `--v8-report` is an error, before it measures: the report runs the
 *   script again in Node.
 * - A run counts bytes only with a runtime that counts them, which
 *   `D8Runtime` doesn't. Its results then record `heap: false`, with or
 *   without `--no-heap`, and its description leaves the bytes out.
 *
 * @throws {TypeError} If an argument isn't one of the options, or a group is
 * malformed, as `measureGroups()` describes.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If the filter isn't a regular expression.
 * @throws {Error} With `--v8-report`, or if the JSON's file can't be
 * written, which it checks before it measures, if the runtime's clock reads
 * no time, or if a variant throws, with its error as the cause.
 */
export async function bench(
    groups: Iterable<Group>,
    options: BenchOptions = {}
): Promise<RunResult> {
    const { json, v8Report, ...command } = parseOptions(
        options.args ?? scriptArguments()
    );
    if (v8Report) {
        throw new Error(
            "Expected no --v8-report in d8: V8's report runs the script again in Node"
        );
    }
    const runtime = options.runtime ?? new D8Runtime();
    const toStdout = json === '-';
    const printLine = options.print ?? (toStdout ? printErr : print);
    if (json != null && !toStdout) {
        checkFile(json);
    }

    const result = await measureAndPrint(
        groups,
        { ...command, heap: command.heap && countsBytes(runtime) },
        runtime,
        printLine
    );

    if (toStdout) {
        (options.write ?? write)(formatJson(result));
    } else if (json != null) {
        writeResults(json, formatJson(result));
    }

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
