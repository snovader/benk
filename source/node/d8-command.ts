// benk-d8, the package's command, which runs a benchmark script in d8, the
// V8 shell, from Node. It takes d8's command line, and runs the script in d8
// as d8 would, where `benk/d8`'s `bench()` measures. d8 can't start a
// process, so that `bench()` can't run the script again for `--processes`
// or `--v8-report`: benk-d8 does, in d8, and prints the ratios across
// processes, and V8's report, as Node's `bench()` does. `source/benk-d8.ts`
// runs it with the process's arguments.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOptions } from '#source/core/command-line';
import { withProcesses } from '#source/core/processes';
import { formatProcesses } from '#source/core/report';
import { RESULT_SCHEMA, type RunResult } from '#source/core/types';
import { inTemporaryDirectory, isMissing } from './child-run.ts';
import { checkDirectory, writeJson } from './json-results.ts';
import { reportTracedRun, runTracedInD8, type D8Run } from './traced-run.ts';
import { parseLoggedVersion } from './v8-trace.ts';

/** benk-d8's own option, which names d8's binary, as `--d8=/opt/v8/d8` */
export const D8_OPTION = '--d8=';

/** The binary that runs the script without `--d8`, from the PATH */
const DEFAULT_D8 = 'd8';

/** Options of the script's that `parseOptions()` reads, by their names */
interface OptionNames {
    /** Options without a value, which `--no-` negates */
    readonly flags: ReadonlySet<string>;
    /** Options with a value, after `=` or in the next argument */
    readonly values: ReadonlySet<string>;
}

/** The options that benk-d8 carries out, which d8 gets none of */
const WRAPPER_OPTIONS: OptionNames = {
    flags: new Set(['v8-report']),
    values: new Set(['v8-filter', 'processes'])
};

/**
 * The options that a run of `--processes` gets none of: those of the
 * report, `--processes`, which d8 can't carry out, and `--json`, in whose
 * place benk-d8 names a file of its own
 */
const PROCESS_RUN_OPTIONS: OptionNames = {
    flags: WRAPPER_OPTIONS.flags,
    values: new Set([...WRAPPER_OPTIONS.values, 'json'])
};

/**
 * The options that the traced run gets none of: those of a run of
 * `--processes`, as the results are of the first run, or of the runs of
 * `--processes`
 */
const TRACED_RUN_OPTIONS = PROCESS_RUN_OPTIONS;

/** Where a run of d8 writes to stdout: where benk-d8 does, to its stderr, or nowhere */
type D8Stdout = 'inherit' | 'stderr' | 'drop';

/**
 * Runs a benchmark script in d8, from benk-d8's command line, as
 * `benk-d8 [--d8=<path>] [d8's flags] <script> [-- <script's options>]`,
 * and returns the code that benk-d8 exits with:
 *
 * 1. It reads the script's options, as `bench()` does, before d8 runs.
 * 2. It runs d8 on the script, with d8's flags, and the script's options
 *    after `--`, except for the options handled by benk-d8. d8 writes to this
 *    process's stdout and stderr. A run that fails ends benk-d8, with d8's
 *    code.
 * 3. With `--processes <n>` of more than 1, it runs d8 on the script n
 *    times, as `runInD8Processes()` does, and prints each variant's ratio
 *    in each run after the first run's tables.
 * 4. With `--v8-report` or `--v8-filter`, it runs the script again in d8,
 *    with V8's trace flags and without `--json` and `--processes`, as
 *    `runTracedInD8()` does, and prints V8's report, where the tables
 *    went: to stdout, or to stderr for `--json -`.
 *
 * @throws {TypeError} If the command line names no script, has another
 * argument than `--` after it, or `--d8` without a path after `=`, or the
 * script's options aren't `bench()`'s, as `parseOptions()` describes.
 * @throws {RangeError} If a number of the script's options is out of its
 * range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 * @throws {Error} With `--v8-check` or `--v8-max-bytecode`, before d8
 * runs: the check needs Node's traced run. If the directory of `--json`
 * can't be written to, with `--processes`, which it checks before d8 runs.
 * If d8 can't be started, as when the PATH has no `d8`, if a run of
 * `--processes` fails, as `runInD8Processes()` describes, or if the traced
 * run fails, or writes no traces, as `runTracedInD8()` and
 * `reportTracedRun()` describe.
 */
export async function runD8Command(args: readonly string[]): Promise<number> {
    const run = readCommand(args);
    const { json, processes, v8Report, v8Filter, v8Check, v8MaxBytecode } =
        parseOptions(run.args);
    if (v8Check) {
        const option =
            v8MaxBytecode == null ? '--v8-check' : '--v8-max-bytecode';
        throw new Error(
            `Expected no ${option} in benk-d8: V8's check needs Node's traced run, which reads where each variant's run starts, and marks the timed rounds`
        );
    }
    const print = json === '-' ? printError : printLine;

    const exit =
        processes > 1
            ? await runInD8Processes(run, { processes, json, print })
            : await runD8(
                  { ...run, args: withoutOptions(run.args, WRAPPER_OPTIONS) },
                  'inherit'
              );
    if (exit !== 0 || !v8Report) {
        return exit;
    }

    const traced = await runTracedInD8({
        ...run,
        args: withoutOptions(run.args, TRACED_RUN_OPTIONS)
    });
    const version = parseLoggedVersion(traced.codeLog);
    const lines = await reportTracedRun(run.script, traced, {
        filter: v8Filter,
        engine: version == null ? 'd8' : `d8 ${version}`
    });
    for (const line of lines) {
        print(line);
    }

    return 0;
}

/**
 * Reads benk-d8's command line, which is d8's: d8's flags, the script, and
 * `--` before the script's options. The script is the first argument that
 * isn't a flag, so a flag with a value takes it after `=`, as d8's
 * `--stack-size=2000`, and benk-d8's own `--d8=<path>`.
 *
 * @throws {TypeError} If it names no script, has another argument than
 * `--` after it, or `--d8` without a path after `=`.
 */
function readCommand(args: readonly string[]): D8Run {
    let d8 = DEFAULT_D8;
    const flags: string[] = [];

    for (let at = 0; at < args.length; at++) {
        const arg = args[at];
        if (arg.startsWith(D8_OPTION) || arg === '--d8') {
            d8 = arg.slice(D8_OPTION.length);
            if (d8 === '') {
                throw new TypeError(
                    `Expected the path of d8's binary in ${D8_OPTION}<path>, got ${arg}`
                );
            }
        } else if (arg.startsWith('-')) {
            flags.push(arg);
        } else {
            return { d8, flags, script: arg, args: scriptOptions(args, at) };
        }
    }

    throw new TypeError(
        'Expected a script to run in d8, as benk-d8 bench.mjs -- --v8-report, got none'
    );
}

/**
 * The script's options: the arguments after the `--` that follows the
 * script, as d8 passes a script those
 *
 * @throws {TypeError} If another argument follows the script, which d8
 * would take for another script or flag of its own.
 */
function scriptOptions(args: readonly string[], script: number): string[] {
    const next = args.at(script + 1);
    if (next != null && next !== '--') {
        throw new TypeError(
            `Expected -- after the script, before its options, as d8 takes them, got ${next}`
        );
    }

    return args.slice(script + 2);
}

/**
 * The script's options without some of them, and their values. They're
 * those that `parseOptions()` read, so an option takes the next argument
 * for its value unless it has one after `=`, and a value after a space
 * doesn't start with `--`.
 */
function withoutOptions(
    args: readonly string[],
    { flags, values }: OptionNames
): string[] {
    const kept: string[] = [];

    for (let at = 0; at < args.length; at++) {
        const arg = args[at];
        const equals = arg.indexOf('=');
        const name = arg.startsWith('--')
            ? arg.slice(2, equals === -1 ? undefined : equals)
            : '';

        if (values.has(name)) {
            // Its value, unless it has it after `=`
            at += equals === -1 ? 1 : 0;
        } else if (!flags.has(name.replace(/^no-/, ''))) {
            kept.push(arg);
        }
    }

    return kept;
}

/** How `runInD8Processes()` runs the script, and where its output goes */
interface D8ProcessesOptions {
    /** The runs of d8 in all, more than 1 */
    readonly processes: number;
    /** The script's `--json`, which benk-d8 writes, or none */
    readonly json: string | undefined;
    /** Prints a line where the tables go: to stdout, or to stderr */
    readonly print: (line: string) => void;
}

/**
 * Runs d8 on the script in several processes, one after another, and
 * returns the code that benk-d8 exits with. d8's runs can't tell that
 * they're repeated, so each prints its tables, and writes its results to a
 * file of benk-d8's, by `--json`, in place of the script's. The first run's
 * output shows where the tables go, and the others' doesn't. Then it prints
 * each variant's ratio in each run, and writes the results where the
 * script's `--json` says, with the other runs'.
 *
 * d8 writes `--json`'s file at each call of `bench()`, so the results are
 * of the script's last call, as without `--processes`, and so are the
 * ratios across processes.
 *
 * @throws {Error} If the directory of `--json` can't be written to, which
 * it checks before d8 runs, if a run after the first exits with another
 * code than 0, or if a run writes no results, as when its script didn't
 * call `bench()`, or measured other groups than the first.
 */
async function runInD8Processes(
    run: D8Run,
    { processes, json, print }: D8ProcessesOptions
): Promise<number> {
    if (json != null && json !== '-') {
        await checkDirectory(json);
    }

    return inTemporaryDirectory(async directory => {
        const results: RunResult[] = [];
        for (let number = 1; number <= processes; number++) {
            const file = join(directory, `${number}.json`);
            const args = [
                '--json',
                file,
                ...withoutOptions(run.args, PROCESS_RUN_OPTIONS)
            ];
            const stdout =
                number > 1 ? 'drop' : json === '-' ? 'stderr' : 'inherit';

            const exit = await runD8({ ...run, args }, stdout);
            if (exit !== 0 && number === 1) {
                return exit;
            }
            const name = `run ${number} of ${processes} of ${run.script} in d8`;
            if (exit !== 0) {
                throw new Error(`Expected ${name} to exit with 0, got ${exit}`);
            }
            results.push(await readResults(file, name));
        }

        const [first, ...others] = results;
        const result = withProcesses(
            first,
            others.map(({ date, runtime, groups }) => ({
                date,
                runtime,
                groups
            }))
        );
        for (const line of formatProcesses(result.processes)) {
            print(line);
        }
        await writeJson(json, result, writeStdout);

        return 0;
    });
}

/**
 * The results that a run of d8 wrote to its file of `--json`
 *
 * @throws {Error} If it wrote none, as when its script didn't call
 * `bench()`.
 */
async function readResults(file: string, name: string): Promise<RunResult> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if (isMissing(error)) {
            throw new Error(
                `Expected ${name} to write its results, as benk/d8's bench() does for --json, got none`,
                { cause: error }
            );
        }
        throw error;
    }

    // Written by benk/d8's bench(), as `formatJson()` writes results
    const result = JSON.parse(text) as RunResult | null;
    if (result?.schema !== RESULT_SCHEMA) {
        throw new Error(
            `Expected ${name} to write result schema ${RESULT_SCHEMA}, got ${result?.schema ?? 'none'}: rebuild the script with the same version of benk as benk-d8`
        );
    }

    return result;
}

/**
 * Runs d8 on a script, with its stderr on this process's, and its stdout as
 * `stdout` says, and returns the code that d8 exited with, or 1 if a signal
 * ended it
 *
 * @throws {Error} If d8 can't be started, as when the PATH has no `d8`.
 */
function runD8(
    { d8, flags, script, args }: D8Run,
    stdout: D8Stdout
): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(d8, [...flags, script, '--', ...args], {
            stdio: [
                'inherit',
                stdout === 'drop'
                    ? 'ignore'
                    : stdout === 'stderr'
                      ? 2
                      : 'inherit',
                'inherit'
            ]
        });

        child.on('error', error => {
            reject(
                new Error(
                    `Expected to run d8, V8's shell, as ${d8}, got ${reasonOf(error)}: install it, as with brew install v8, or give the path of its binary with ${D8_OPTION}<path>`,
                    { cause: error }
                )
            );
        });
        child.on('close', code => {
            resolve(code ?? 1);
        });
    });
}

/** What an error says, briefly: a system error's code, as ENOENT, or its message */
function reasonOf(error: Error): string {
    return 'code' in error && typeof error.code === 'string'
        ? error.code
        : error.message;
}

function printLine(line: string): void {
    console.log(line);
}

function printError(line: string): void {
    console.error(line);
}

function writeStdout(text: string): void {
    process.stdout.write(text);
}
