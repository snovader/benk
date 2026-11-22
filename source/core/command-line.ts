// What each entry point's `bench()` shares: a benchmark script's options,
// read from its command-line arguments, and the run that prints its
// description and each group's table. It reads no host's arguments and
// prints to no host's output itself: Node's `bench()` passes
// `process.argv`'s arguments and the console, and d8's passes its
// `arguments` and `print()`.
import { readArguments, type ArgumentSpec } from './arguments.ts';
import {
    measureGroups,
    DEFAULT_OPTIONS,
    type MeasureOptions
} from './measure.ts';
import { describeRun, formatGroup } from './report.ts';
import type { Group, RunResult, Runtime } from './types.ts';

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
     * and print a report of its hot functions, as `--v8-report` asks, and
     * each of the options below
     */
    readonly v8Report: boolean;
    /** Selects the functions of V8's report by name, or none if all of them */
    readonly v8Filter: RegExp | undefined;
    /**
     * Whether to check the functions of V8's report against Turbofan's
     * limits, and for deoptimizations in the timed rounds, and fail the run
     * if one fails, as `--v8-check` or `--v8-max-bytecode` asks
     */
    readonly v8Check: boolean;
    /**
     * The user's limit on the bytecode of a hot function, in bytes, which
     * the check checks too, or none
     */
    readonly v8MaxBytecode: number | undefined;
}

/** How `bench()` runs, for a script that runs it other than from the shell */
export interface BenchOptions {
    /**
     * The command-line arguments, which each entry point's `bench()` reads
     * from its host by default: `process.argv.slice(2)` in Node, and d8's
     * `arguments`
     */
    readonly args?: readonly string[];
    /**
     * The runtime that times the variants: `NodeRuntime` by default in
     * Node, and `D8Runtime` in d8
     */
    readonly runtime?: Runtime;
    /**
     * Prints a line of the tables: to stdout by default, or to stderr when
     * the JSON goes to stdout
     */
    readonly print?: (line: string) => void;
    /** Writes the JSON to stdout, when `--json -` asks for it */
    readonly write?: (text: string) => void;
}

/** The options of a run that `measureAndPrint()` measures and describes */
type PrintedRunOptions = Required<MeasureOptions> &
    Pick<CommandOptions, 'filter'>;

/** The command line's options, by their names as arguments */
const OPTIONS: ArgumentSpec = {
    values: new Set([
        'rounds',
        'warmup-rounds',
        'sample-ms',
        'filter',
        'json',
        'v8-filter',
        'v8-max-bytecode'
    ]),
    flags: new Set(['aa', 'heap', 'v8-report', 'v8-check'])
};

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
 * - `--v8-check`: checks the functions of V8's report, and fails the run if
 *   one fails, and implies `--v8-report`
 * - `--v8-max-bytecode <bytes>`: a limit on the bytecode of a hot function,
 *   which the check checks too, and implies `--v8-check`
 *
 * It reads them as Node's `parseArgs()` does, on any runtime.
 *
 * @throws {TypeError} If an argument isn't one of the options, or an option
 * has no value.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 */
export function parseOptions(args: readonly string[]): CommandOptions {
    const { values, flags } = readArguments(args, OPTIONS);
    const v8MaxBytecode = maxBytecodeOption(values.get('v8-max-bytecode'));
    const v8Check = (flags.get('v8-check') ?? false) || v8MaxBytecode != null;

    return {
        rounds: integerOption(
            values.get('rounds'),
            '--rounds',
            1,
            DEFAULT_OPTIONS.rounds
        ),
        warmupRounds: integerOption(
            values.get('warmup-rounds'),
            '--warmup-rounds',
            0,
            DEFAULT_OPTIONS.warmupRounds
        ),
        sampleTime: sampleTimeOption(values.get('sample-ms')),
        aa: flags.get('aa') ?? DEFAULT_OPTIONS.aa,
        heap: flags.get('heap') ?? DEFAULT_OPTIONS.heap,
        filter: filterOption(values.get('filter'), '--filter'),
        json: values.get('json'),
        v8Report:
            (flags.get('v8-report') ?? false) ||
            values.get('v8-filter') != null ||
            v8Check,
        v8Filter: filterOption(values.get('v8-filter'), '--v8-filter'),
        v8Check,
        v8MaxBytecode
    };
}

/**
 * Measures the groups as `measureGroups()` does, and prints what each
 * entry point's `bench()` prints: a description of the run first, and then
 * each group's table as soon as it's measured
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If a group has no variants, or two of the same name.
 * @throws {Error} If the runtime's clock reads no time, or if a variant
 * throws, with its error as the cause.
 */
export function measureAndPrint(
    groups: Iterable<Group>,
    options: PrintedRunOptions,
    runtime: Runtime,
    print: (line: string) => void
): Promise<RunResult> {
    print(
        describeRun(runtime.description, {
            ...options,
            filter: options.filter?.source ?? ''
        })
    );

    return measureGroups(
        groups,
        {
            ...options,
            onGroup: group => {
                for (const line of formatGroup(group)) {
                    print(line);
                }
            }
        },
        runtime
    );
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
    return value == null ? otherwise : integerOf(value, name, least);
}

function maxBytecodeOption(value: string | undefined): number | undefined {
    return value == null ? undefined : integerOf(value, '--v8-max-bytecode', 1);
}

/**
 * An option's integer
 *
 * @throws {RangeError} If it isn't one, or is less than `least`.
 */
function integerOf(value: string, name: string, least: number): number {
    // Digits only, as Number() reads an empty string as 0
    const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
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
