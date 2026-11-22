import { access, constants, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
    measureAndPrint,
    parseOptions,
    type BenchOptions
} from '#source/core/command-line';
import { measureGroups } from '#source/core/measure';
import { formatJson } from '#source/core/report';
import type { Group, RunResult, Runtime } from '#source/core/types';
import { NodeRuntime } from './runtime.ts';
import { readSourceMaps } from './source-maps.ts';
import { isTracedRun, recordSourceMaps, runTraced } from './traced-run.ts';
import { formatV8Report, reportFunctions, tracedScripts } from './v8-report.ts';
import { parseCodeLog, parseTrace } from './v8-trace.ts';

/**
 * Runs a benchmark script: reads its options from the command line, prints
 * a description of the run, measures each group whose name matches the
 * filter and prints its table, and then writes the results as JSON, if the
 * options ask for it. With `--v8-report`, it then runs the script again
 * with V8's traces, and prints a report of its hot functions, or of those
 * that `--v8-filter` selects.
 *
 * In that traced run, it measures as in any other, but prints nothing,
 * writes no JSON, and doesn't run the script again. It then reads the
 * source maps of the scripts that V8 compiled, before it returns, for the
 * report.
 *
 * @throws {TypeError} If an argument isn't one of the options, or a group is
 * malformed, as `measureGroups()` describes.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 * @throws {Error} If the JSON's directory can't be written to, or
 * `--v8-report` has no script to run again, which it checks before it
 * measures, if the runtime's clock reads no time, if a variant throws, with
 * its error as the cause, or if the traced run fails, or writes no traces.
 */
export async function bench(
    groups: Iterable<Group>,
    options: BenchOptions = {}
): Promise<RunResult> {
    const { json, v8Report, v8Filter, ...command } = parseOptions(
        options.args ?? process.argv.slice(2)
    );
    const runtime = options.runtime ?? defaultRuntime();
    if (isTracedRun()) {
        // The process that runs this one prints the report, and the results
        const result = await measureGroups(groups, command, runtime);
        await recordSourceMaps();
        return result;
    }

    const toStdout = json === '-';
    const print =
        options.print ??
        (toStdout ? printError : (line: string) => console.log(line));
    if (json != null && !toStdout) {
        await checkDirectory(json);
    }
    const script = v8Report ? scriptToTrace() : undefined;

    const result = await measureAndPrint(groups, command, runtime, print);

    if (toStdout) {
        (options.write ?? writeStdout)(formatJson(result));
    } else if (json != null) {
        await writeFile(json, formatJson(result));
    }

    if (script != null) {
        for (const line of await traceScript(script, v8Filter)) {
            print(line);
        }
    }

    return result;
}

let nodeRuntime: NodeRuntime | undefined;

/**
 * The runtime of the process, which keeps the heap baselines that it
 * measured between runs
 */
export function defaultRuntime(): Runtime {
    nodeRuntime ??= new NodeRuntime();
    return nodeRuntime;
}

/**
 * Checks that the directory of the results' file can be written to, before
 * the run rather than after it, when a mistyped path would lose the
 * measurements
 */
async function checkDirectory(path: string): Promise<void> {
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
 * The script that `--v8-report` runs again: the process's entry script
 *
 * @throws {Error} If the process has none, as in Node's REPL.
 */
function scriptToTrace(): string {
    const script = process.argv.at(1);
    if (script == null) {
        throw new Error(
            'Expected a script to run again for --v8-report, as process.argv[1]'
        );
    }

    return script;
}

/**
 * Runs the script again with V8's traces, with the arguments of this
 * process, and returns the lines of the report, of the functions that the
 * filter selects. It takes the scripts' source maps from the traced run,
 * which read them before its `bench()` returned. The script's code after
 * `bench()` runs in the traced run too, and may delete a bundle. It reads
 * the source maps of other scripts after the run.
 *
 * @throws {Error} If the traced run fails, or its traces have none of V8's
 * compilations, or its log none of its functions, as when V8 changed their
 * formats.
 */
async function traceScript(
    script: string,
    filter: RegExp | undefined
): Promise<string[]> {
    const { output, codeLog, sourceMapFiles } = await runTraced(
        script,
        process.argv.slice(2)
    );
    const trace = parseTrace(output);
    const logged = parseCodeLog(codeLog);
    if (trace.compilations.length === 0 || logged.size === 0) {
        // A line that V8 wrote of a compilation, which says what it wrote
        const line = output
            .split('\n')
            .find(text => text.startsWith('[completed compiling'));
        throw new Error(
            `Expected V8's compilations and functions in the traced run of ${script}, got ${trace.compilations.length} and ${logged.size}: V8 ${process.versions.v8} may write other formats${line == null ? '' : `, as ${line.trimEnd()}`}`
        );
    }

    const sourceMaps = await readSourceMaps(
        tracedScripts(trace, logged),
        sourceMapFiles
    );
    const reports = reportFunctions(trace, logged, {
        benkDirectory: benkDirectory(),
        filter,
        sourceMaps
    });
    return formatV8Report(reports, {
        script,
        directory: process.cwd(),
        filter,
        sourceMaps
    });
}

/**
 * The URL of the directory of benk's own modules, whose functions the V8
 * report leaves out: `dist`, of the bundle, which has this module in it, or
 * `source`, which has this module's directory in it
 */
function benkDirectory(): string {
    const url = import.meta.url;

    return new URL(url.endsWith('.ts') ? '..' : '.', url).href;
}

function printError(line: string): void {
    console.error(line);
}

function writeStdout(text: string): void {
    process.stdout.write(text);
}
