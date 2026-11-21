import { access, constants, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { measureGroups, DEFAULT_OPTIONS } from '#source/core/measure';
import { describeRun, formatGroup, formatJson } from '#source/core/report';
import type { Group, RunResult, Runtime } from '#source/core/types';
import { NodeRuntime } from './runtime.ts';

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
 * - `--no-heap`: leaves out the count of heap bytes
 *
 * @throws {TypeError} If an argument isn't one of the options, or an option
 * has no value.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If the filter isn't a regular expression.
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
            heap: { type: 'boolean', default: DEFAULT_OPTIONS.heap }
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
        filter: filterOption(values.filter),
        json: values.json
    };
}

/**
 * Runs a benchmark script: reads its options from the command line, prints
 * a description of the run, measures each group whose name matches the
 * filter and prints its table, and then writes the results as JSON, if the
 * options ask for it
 *
 * @throws {TypeError} If an argument isn't one of the options, or a group is
 * malformed, as `measureGroups()` describes.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If the filter isn't a regular expression.
 * @throws {Error} If the JSON's directory can't be written to, which it
 * checks before it measures, if the runtime's clock reads no time, or if
 * a variant throws, with its error as the cause.
 */
export async function bench(
    groups: Iterable<Group>,
    options: BenchOptions = {}
): Promise<RunResult> {
    const { json, ...command } = parseOptions(
        options.args ?? process.argv.slice(2)
    );
    const toStdout = json === '-';
    const print =
        options.print ??
        (toStdout ? printError : (line: string) => console.log(line));
    const runtime = options.runtime ?? defaultRuntime();
    if (json != null && !toStdout) {
        await checkDirectory(json);
    }

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

function filterOption(value: string | undefined): RegExp | undefined {
    if (value == null) {
        return undefined;
    }

    try {
        return new RegExp(value, 'u');
    } catch (error) {
        throw new SyntaxError(
            `Expected --filter to be a regular expression, got ${value}`,
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
