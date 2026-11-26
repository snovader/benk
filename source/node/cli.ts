import { access, constants, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
    measureAndPrint,
    parseOptions,
    type BenchOptions,
    type CommandOptions
} from '#source/core/command-line';
import { measureGroups, type MeasureOptions } from '#source/core/measure';
import { formatJson } from '#source/core/report';
import type {
    Group,
    GroupResult,
    InliningLimits,
    RunResult,
    Runtime,
    V8Report,
    VariantResult,
    VariantV8
} from '#source/core/types';
import { functionPositions } from './function-positions.ts';
import { NodeRuntime } from './runtime.ts';
import { writeMarker, type TracedGroup } from './traced-markers.ts';
import {
    isTracedRun,
    readTracedReport,
    recordSourceMaps,
    runTraced
} from './traced-run.ts';
import { checkFunctions } from './v8-check.ts';
import { readInliningLimits } from './v8-limits.ts';
import {
    formatCheck,
    formatLimits,
    formatV8Report,
    formatVariants,
    type FormatOptions,
    type FunctionReport,
    type VariantFormat
} from './v8-report.ts';
import { plainReport, variantsV8 } from './v8-results.ts';

/**
 * The exit code of a run whose V8 check failed, which `bench()` sets. It
 * tells the check's failure from an error that the run threw, after which
 * Node exits with 1.
 */
export const V8_CHECK_FAILED = 2;

/**
 * The calls of `bench()` in this process so far. The traced run's calls
 * are numbered alike, as it runs the same script, so that a call's report
 * is of its own groups.
 */
let benchCalls = 0;

/**
 * Runs a benchmark script: reads its options from the command line, prints
 * a description of the run, measures each group whose name matches the
 * filter and prints its table, and then writes the results as JSON, if the
 * options ask for it.
 *
 * With `--v8-report`, it runs the script again with V8's traces before it
 * writes the JSON, and prints a report of its hot functions, or of those
 * that `--v8-filter` selects, and of each variant's code. The results have
 * the report too. With `--v8-check`, it checks the report's functions, and
 * sets `process.exitCode` to `V8_CHECK_FAILED` if one fails, unless the
 * script has set another. It doesn't exit: the script's code after it runs.
 * Last, it calls the `after` option, with the `print` that printed the
 * tables, and the results.
 *
 * In that traced run, it measures as in any other, but prints nothing,
 * writes no JSON, doesn't call `after`, and doesn't run the script again. It writes markers among
 * V8's traces, of its calls and groups' timed rounds, and of where each
 * variant's `run` starts, which it reads after measuring. It then reads the
 * source maps of the scripts that V8 compiled, before it returns.
 *
 * @throws {TypeError} If an argument isn't one of the options, or a group is
 * malformed, as `measureGroups()` describes.
 * @throws {RangeError} If a number is out of its range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 * @throws {Error} If the JSON's directory can't be written to, or
 * `--v8-report` has no script to run again, which it checks before it
 * measures, if the runtime's clock reads no time, if a variant throws, with
 * its error as the cause, if the traced run fails, or writes no traces, if
 * `--v8-check` has no limits from V8, or if `after` throws, with its error. If the traced run fails, it writes
 * the JSON without the report first.
 */
export async function bench(
    groups: Iterable<Group>,
    options: BenchOptions = {}
): Promise<RunResult> {
    const { json, v8Report, v8Filter, v8Check, v8MaxBytecode, ...command } =
        parseOptions(options.args ?? process.argv.slice(2));
    const runtime = options.runtime ?? defaultRuntime();
    const call = benchCalls++;
    if (isTracedRun()) {
        // The process that runs this one prints the report, and the results
        const result = await measureTraced(groups, command, runtime, call);
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

    const measured = await measureAndPrint(groups, command, runtime, print);

    let result = measured;
    let report: string[] = [];
    try {
        if (script != null) {
            ({ result, lines: report } = await traceScript(script, measured, {
                call,
                filter: v8Filter,
                check: v8Check,
                maxBytecodeSize: v8MaxBytecode
            }));
        }
    } finally {
        if (toStdout) {
            (options.write ?? writeStdout)(formatJson(result));
        } else if (json != null) {
            await writeFile(json, formatJson(result));
        }
    }

    for (const line of report) {
        print(line);
    }
    // A code that the script has set, or '0', says more than the check's
    const exitCode = process.exitCode ?? 0;
    if (result.v8Report?.check?.passed === false && Number(exitCode) === 0) {
        process.exitCode = V8_CHECK_FAILED;
    }

    await options.after?.(print, result);

    return result;
}

/**
 * Measures the groups in the traced run, and marks among V8's traces where
 * this call of `bench()` starts and ends, and each group's timed rounds.
 * After measuring, it marks where each variant's `run` starts.
 */
async function measureTraced(
    groups: Iterable<Group>,
    options: Required<MeasureOptions> & Pick<CommandOptions, 'filter'>,
    runtime: Runtime,
    call: number
): Promise<RunResult> {
    const measured: Group[] = [];

    writeMarker({ bench: call, event: 'start' });
    const result = await measureGroups(
        groups,
        {
            ...options,
            onRounds: (group, rounds) => {
                if (rounds === 'timed') {
                    measured.push(group);
                }
                writeMarker({
                    bench: call,
                    event: rounds,
                    group: measured.length - 1
                });
            }
        },
        runtime
    );
    writeMarker({ bench: call, event: 'end' });

    writeMarker({
        bench: call,
        event: 'variants',
        groups: await tracedGroups(result.groups, measured)
    });
    return result;
}

/**
 * The groups that the traced run measured, with where each variant's `run`
 * starts. The results' groups are those measured, in the same order, and an
 * A/A copy runs its reference's `run`.
 */
async function tracedGroups(
    results: readonly GroupResult[],
    measured: readonly Group[]
): Promise<TracedGroup[]> {
    const runs = results.map((result, i) =>
        result.variants.map(variant => runOf(measured[i], variant))
    );
    const unique = Array.from(new Set(runs.flat()));
    const positions = new Map(
        (await functionPositions(unique)).map((position, i) => [
            unique[i],
            position
        ])
    );

    return results.map((result, i) => ({
        name: result.name,
        variants: result.variants.map(({ name, role }, j) => ({
            name,
            role,
            run: positions.get(runs[i][j]) ?? null
        }))
    }));
}

/** The `run` of a variant of a group's results */
function runOf(group: Group, { name, role }: VariantResult): () => unknown {
    const [reference] = group.variants;
    const variant =
        role === 'aa' ? reference : group.variants.find(v => v.name === name);

    // The results have each variant of the group, by its name
    return (variant ?? reference).run;
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

/** What `traceScript()` reports on */
interface TraceOptions {
    /** The number of the call of `bench()` in the process */
    readonly call: number;
    /** Selects the functions that the report lists, and the check checks */
    readonly filter: RegExp | undefined;
    /** Whether to check the report's functions */
    readonly check: boolean;
    /** The user's limit on a hot function's bytecode */
    readonly maxBytecodeSize: number | undefined;
}

/**
 * Runs the script again with V8's traces, with the arguments of this
 * process, and returns the results with V8's report, and the report's lines:
 * of the functions that the filter selects, of each variant's code, of
 * Turbofan's limits, and of the check, if asked for. It takes the scripts'
 * source maps from the traced run, which read them before its `bench()`
 * returned. The script's code after `bench()` runs in the traced run too,
 * and may delete a bundle. It reads the source maps of other scripts after
 * the run.
 *
 * @throws {Error} If the traced run fails, or its traces have none of V8's
 * compilations, or its log none of its functions, as when V8 changed their
 * formats, or if the check has no limits from V8.
 */
async function traceScript(
    script: string,
    measured: RunResult,
    { call, filter, check, maxBytecodeSize }: TraceOptions
): Promise<{ result: RunResult; lines: string[] }> {
    const traced = await runTraced(script, process.argv.slice(2));
    const { marked, logged, sourceMaps, reports, isScript } =
        await readTracedReport(script, traced, { filter });
    const limits = await inliningLimits(check);

    // This call's part of the traced run, of its own groups
    const bench = marked.benches.get(call);
    const variants =
        bench == null
            ? undefined
            : variantsV8(measured.groups, bench, logged, sourceMaps);
    // Each group's timed rounds, where the traces place them
    const timed = bench?.timed?.map((trace, i) => ({
        name: measured.groups.at(i)?.name ?? '',
        trace
    }));

    const v8Report: V8Report = {
        script,
        filter: filter?.source ?? '',
        limits,
        functions: reports.map(plainReport),
        check:
            check && limits != null
                ? checkFunctions(reports, timed, {
                      limits,
                      maxBytecodeSize,
                      isScript,
                      sourceMaps
                  })
                : null
    };
    const result = { ...withReport(measured, variants), v8Report };

    return {
        result,
        lines: reportLines(reports, result, { filter, sourceMaps, isScript })
    };
}

/**
 * Turbofan's limits, as `readInliningLimits()` reads them
 *
 * @throws {Error} If V8 printed none, and the check needs them.
 */
async function inliningLimits(check: boolean): Promise<InliningLimits | null> {
    const limits = await readInliningLimits();
    if (check && limits == null) {
        throw new Error(
            `Expected Turbofan's limits for --v8-check from node --v8-options, but V8 ${process.versions.v8} printed none of its flags --max-inlined-bytecode-size and others`
        );
    }

    return limits;
}

/**
 * The lines of V8's report: its functions, each group's variants, Turbofan's
 * limits, and the check, if there's one, with paths relative to the
 * directory that the script runs in
 */
function reportLines(
    reports: readonly FunctionReport[],
    { groups, v8Report }: RunResult & { v8Report: V8Report },
    options: Pick<FormatOptions, 'filter' | 'sourceMaps'> &
        Pick<VariantFormat, 'isScript'>
): string[] {
    const { script, limits, check } = v8Report;
    const directory = process.cwd();

    return [
        ...formatV8Report(reports, { ...options, script, directory }),
        ...formatVariants(groups, { directory, isScript: options.isScript }),
        '',
        formatLimits(limits),
        ...(check == null ? [] : formatCheck(check, directory))
    ];
}

/** The results with each variant's part of V8's report */
function withReport(
    result: RunResult,
    variants: ReadonlyArray<ReadonlyArray<VariantV8 | null>> | undefined
): RunResult {
    return {
        ...result,
        groups: result.groups.map((group, i) => ({
            ...group,
            variants: group.variants.map((variant, j) => ({
                ...variant,
                v8: variants?.[i][j] ?? null
            }))
        }))
    };
}

function printError(line: string): void {
    console.error(line);
}

function writeStdout(text: string): void {
    process.stdout.write(text);
}
