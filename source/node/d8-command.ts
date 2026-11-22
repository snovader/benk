// benk-d8, the package's command, which runs a benchmark script in d8, the
// V8 shell, from Node. It takes d8's command line, and runs the script in d8
// as d8 would, where `benk/d8`'s `bench()` measures. d8 can't start a
// process, so that `bench()` can't run the script again for `--v8-report`:
// benk-d8 does, in d8, with V8's trace flags, and prints the report as
// Node's `bench()` does. `source/benk-d8.ts` runs it with the process's
// arguments.
import { spawn } from 'node:child_process';
import { parseOptions } from '#source/core/command-line';
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
const REPORT_OPTIONS: OptionNames = {
    flags: new Set(['v8-report']),
    values: new Set(['v8-filter'])
};

/**
 * The options that the traced run gets none of: those of the report, and
 * `--json`, as the results are of the first run
 */
const TRACED_RUN_OPTIONS: OptionNames = {
    flags: REPORT_OPTIONS.flags,
    values: new Set([...REPORT_OPTIONS.values, 'json'])
};

/**
 * Runs a benchmark script in d8, from benk-d8's command line, as
 * `benk-d8 [--d8=<path>] [d8's flags] <script> [-- <script's options>]`,
 * and returns the code that benk-d8 exits with:
 *
 * 1. It reads the script's options, as `bench()` does, before d8 runs.
 * 2. It runs d8 on the script, with d8's flags, and the script's options
 *    after `--`, but for `--v8-report` and `--v8-filter`. d8 writes to this
 *    process's stdout and stderr. A run that fails ends benk-d8, with d8's
 *    code.
 * 3. With `--v8-report` or `--v8-filter`, it runs the script again in d8,
 *    with V8's trace flags and without `--json`, as `runTracedInD8()`
 *    does, and prints V8's report, where the tables went: to stdout, or to
 *    stderr for `--json -`.
 *
 * @throws {TypeError} If the command line names no script, has another
 * argument than `--` after it, or `--d8` without a path after `=`, or the
 * script's options aren't `bench()`'s, as `parseOptions()` describes.
 * @throws {RangeError} If a number of the script's options is out of its
 * range.
 * @throws {SyntaxError} If a filter isn't a regular expression.
 * @throws {Error} With `--v8-check` or `--v8-max-bytecode`, before d8
 * runs: the check needs Node's traced run. If d8 can't be started, as when
 * the PATH has no `d8`, or if the traced run fails, or writes no traces, as
 * `runTracedInD8()` and `reportTracedRun()` describe.
 */
export async function runD8Command(args: readonly string[]): Promise<number> {
    const run = readCommand(args);
    const { json, v8Report, v8Filter, v8Check, v8MaxBytecode } = parseOptions(
        run.args
    );
    if (v8Check) {
        const option =
            v8MaxBytecode == null ? '--v8-check' : '--v8-max-bytecode';
        throw new Error(
            `Expected no ${option} in benk-d8: V8's check needs Node's traced run, which reads where each variant's run starts, and marks the timed rounds`
        );
    }
    const print = json === '-' ? printError : printLine;

    const exit = await runD8({
        ...run,
        args: withoutOptions(run.args, REPORT_OPTIONS)
    });
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

/**
 * Runs d8 on a script, with its output on this process's, and returns the
 * code that d8 exited with, or 1 if a signal ended it
 *
 * @throws {Error} If d8 can't be started, as when the PATH has no `d8`.
 */
function runD8({ d8, flags, script, args }: D8Run): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(d8, [...flags, script, '--', ...args], {
            stdio: 'inherit'
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
