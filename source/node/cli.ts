import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_OPTIONS, measureGroups } from '#source/core/measure';
import { describeRun, formatGroup, formatJson } from '#source/core/report';
import type { Group, Runtime, RunResult } from '#source/core/types';
import { detachArrayBuffer, NodeRuntime } from './runtime.ts';

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
    /** Whether to detach an ArrayBuffer first, as `detachArrayBuffer()` does */
    readonly detachArrayBuffer: boolean;
}

/** How `main()` runs, for a script that runs it other than from the shell */
export interface MainOptions {
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
 * - `--detach-array-buffer`: detaches an ArrayBuffer before the run, as
 *   `detachArrayBuffer()` describes
 *
 * @throws {TypeError} If an argument isn't one of the options, or an option
 * has no value.
 * @throws {RangeError} If a number is out of its range.
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
            'detach-array-buffer': { type: 'boolean', default: false }
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
        filter:
            values.filter === undefined
                ? undefined
                : new RegExp(values.filter, 'u'),
        json: values.json,
        detachArrayBuffer: values['detach-array-buffer']
    };
}

/**
 * Runs a benchmark script: reads its options from the command line, detaches
 * an ArrayBuffer if they ask for it, prints a description of the run, measures each group whose name matches the
 * filter and prints its table, and then writes the results as JSON, if the
 * options ask for it
 *
 * @throws {TypeError} If an argument isn't one of the options, or a group is
 * malformed, as `measureGroups()` describes.
 * @throws {RangeError} If a number is out of its range.
 * @throws {Error} If a variant throws, with its error as the cause.
 */
export async function main(
    groups: Iterable<Group>,
    options: MainOptions = {}
): Promise<RunResult> {
    const {
        json,
        detachArrayBuffer: detach,
        ...command
    } = parseOptions(options.args ?? process.argv.slice(2));
    if (detach) {
        detachArrayBuffer();
    }

    const toStdout = json === '-';
    const print =
        options.print ??
        (toStdout ? printError : (line: string) => console.log(line));
    const runtime = options.runtime ?? defaultRuntime();

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
    } else if (json !== undefined) {
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

function integerOption(
    value: string | undefined,
    name: string,
    least: number,
    otherwise: number
): number {
    // Digits only, as Number() reads an empty string as 0
    const number =
        value === undefined
            ? otherwise
            : /^\d+$/u.test(value)
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
    const number =
        value === undefined ? DEFAULT_OPTIONS.sampleTime : Number(value);
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
