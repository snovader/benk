import { access, constants, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { measureGroups, DEFAULT_OPTIONS } from '#source/core/measure';
import { describeRun, formatGroup, formatJson } from '#source/core/report';
import type { Group, RunResult, Runtime } from '#source/core/types';
import { NodeRuntime } from './runtime.ts';
import { readSourceMaps } from './source-maps.ts';
import { isTracedRun, runTraced } from './traced-run.ts';
import { formatV8Report, reportFunctions, tracedScripts } from './v8-report.ts';
import { parseCodeLog, parseTrace } from './v8-trace.ts';

/** The options of a benchmark script, from its command line */
export interface CommandOptions {
    readonly rounds: number;
    readonly warmupRounds: number;
    readonly sampleTime: number;
    readonly aa: boolean;
    readonly heap: boolean;
    /** Selects groups by name, or none if all of them */
    readonly filter: RegExp | undefined;
    /** Where to write the results as JSON: a path, `-` for stdout, or none */
    readonly json: string | undefined;
    /**
     * Whether to run the script again with V8's traces, after measuring,
     * and print a report of its hot functions, as `--v8-report` or
     * `--v8-filter` asks
     */
    readonly v8Report: boolean;
    /** Selects the functions of V8's report by name, or none if all of them */
    readonly v8Filter: RegExp | undefined;
}

/** How `bench()` runs, for a script that runs it other than from the shell */
export interface BenchOptions {
    /** The command-line arguments, `process.argv.slice(2)` by default */
    readonly args?: readonly string[];
    readonly runtime?: Runtime;
    /**
     * Prints a line of the tables: to stdout by default, or to stderr when
     * the JSON goes to stdout
     */
    readonly print?: (line: string) => void;
    /** Writes the JSON to stdout, when `--json -` asks for it */
    readonly write?: (text: string) => void;
}

/**
 * Reads a benchmark script's options from its command-line arguments:
 *
 * - `--rounds <n>`: the timed rounds, at least, 31 by default
 * - `--warmup-rounds <n>`: 10 by default
 * - `--sample-ms <ms>`: the time of one variant's round, 1 by default
 * - `--filter <regex>`: selects groups by name
 * - `--json <path>`: writes the results as JSON to a file, or to stdout for
 *   `-`, when the tables go to stderr
 * - `--no-aa`: leaves out the A/A copy of each group's first variant
 * - `--no-heap`: leaves out the counts of bytes allocated, on the heap and
 *   in array buffers
 * - `--v8-report`: runs the script again with V8's traces, and prints a
 *   report of its hot functions
 * - `--v8-filter <regex>`: selects the functions of V8's report by name,
 *   and implies `--v8-report`
 *
 * @throws {TypeError} If an argument isn't one of the options, or an option
 * has no value.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 */
export function parseOptions(args: readonly string[]): CommandOptions {
    const { values } = parseArgs({
        args: [...args],
        allowNegative: true,
        options: {
            rounds: { type: 'string' },
            'warmup-rounds': { type: 'string' },
            'sample-ms': { type: 'string' },
            filter: { type: 'string' },
            json: { type: 'string' },
            aa: { type: 'boolean', default: DEFAULT_OPTIONS.aa },
            heap: { type: 'boolean', default: DEFAULT_OPTIONS.heap },
            'v8-report': { type: 'boolean', default: false },
            'v8-filter': { type: 'string' }
        }
    });

    return {
        rounds: integerOption(
            values.rounds,
            '--rounds',
            1,
            DEFAULT_OPTIONS.rounds
        ),
        warmupRounds: integerOption(
            values['warmup-rounds'],
            '--warmup-rounds',
            0,
            DEFAULT_OPTIONS.warmupRounds
        ),
        sampleTime: sampleTimeOption(values['sample-ms']),
        aa: values.aa,
        heap: values.heap,
        filter: filterOption(values.filter, '--filter'),
        json: values.json,
        v8Report: values['v8-report'] || values['v8-filter'] != null,
        v8Filter: filterOption(values['v8-filter'], '--v8-filter')
    };
}

/**
 * Runs a benchmark script: reads its options from the command line, prints
 * a description of the run, measures each group whose name matches the
 * filter and prints its table, and then writes the results as JSON, if the
 * options ask for it. With `--v8-report`, it then runs the script again
 * with V8's traces, and prints a report of its hot functions, or of those
 * that `--v8-filter` selects.
 *
 * In that traced run, it measures as in any other, but prints nothing,
 * writes no JSON, and doesn't run the script again.
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
        return measureGroups(groups, command, runtime);
    }

    const toStdout = json === '-';
    const print =
        options.print ??
        (toStdout ? printError : (line: string) => console.log(line));
    if (json != null && !toStdout) {
        await checkDirectory(json);
    }
    const script = v8Report ? scriptToTrace() : undefined;

    print(
        describeRun(runtime.description, {
            ...command,
            filter: command.filter?.source ?? ''
        })
    );
    const result = await measureGroups(
        groups,
        {
            ...command,
            onGroup: group => {
                for (const line of formatGroup(group)) {
                    print(line);
                }
            }
        },
        runtime
    );

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
 * filter selects. It reads the scripts' source maps straight after the run,
 * before a build that bundled the script may delete it.
 *
 * @throws {Error} If the traced run fails, or its traces have none of V8's
 * compilations, or its log none of its functions, as when V8 changed their
 * formats.
 */
async function traceScript(
    script: string,
    filter: RegExp | undefined
): Promise<string[]> {
    const { output, codeLog } = await runTraced(script, process.argv.slice(2));
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

    const sourceMaps = await readSourceMaps(tracedScripts(trace, logged));
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

function filterOption(
    value: string | undefined,
    name: string
): RegExp | undefined {
    if (value == null) {
        return undefined;
    }

    try {
        return new RegExp(value, 'u');
    } catch (error) {
        throw new SyntaxError(
            `Expected ${name} to be a regular expression, got ${value}`,
            { cause: error }
        );
    }
}

function integerOption(
    value: string | undefined,
    name: string,
    least: number,
    otherwise: number
): number {
    // Digits only, as Number() reads an empty string as 0
    const number =
        value == null
            ? otherwise
            : /^\d+$/.test(value)
              ? Number(value)
              : Number.NaN;
    if (!Number.isInteger(number) || number < least) {
        throw new RangeError(
            `Expected ${name} to be an integer of at least ${least}, got ${value}`
        );
    }

    return number;
}

function sampleTimeOption(value: string | undefined): number {
    const number = value == null ? DEFAULT_OPTIONS.sampleTime : Number(value);
    if (!(number > 0 && number < Infinity)) {
        throw new RangeError(
            `Expected --sample-ms to be a positive number, got ${value}`
        );
    }

    return number;
}

function printError(line: string): void {
    console.error(line);
}

function writeStdout(text: string): void {
    process.stdout.write(text);
}
