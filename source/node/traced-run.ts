// The traced run of `--v8-report`: the benchmark script run again, in a
// child process of Node or of d8, the V8 shell, with V8's flags that trace
// what its compilers do. `v8-trace.ts` parses what the run writes, and
// `v8-report.ts` reports it, as `reportTracedRun()` puts them together. A run
// in Node records the source maps of its scripts before its `bench()`
// returns, as `source-maps.ts` reads them, and marks its calls of `bench()`
// among the traces, as `traced-markers.ts` describes.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { D8_TRACED_RUN } from '#source/d8/traced-run';
import {
    childRunValue,
    inTemporaryDirectory,
    isMissing,
    runChild,
    TRACED_RUN
} from './child-run.ts';
import {
    readSourceMapFile,
    readSourceMaps,
    type SourceMapFile,
    type SourceMaps
} from './source-maps.ts';
import { readTracedOutput, type MarkedOutput } from './traced-markers.ts';
import {
    formatV8Report,
    isScriptUrl,
    reportFunctions,
    tracedScripts,
    type FunctionReport
} from './v8-report.ts';
import {
    parseCodeLog,
    type FunctionAddress,
    type LoggedFunction
} from './v8-trace.ts';

/**
 * V8's flags of the traced run, in Node and in d8. The traces go to stdout,
 * among what the script writes there, and the code log to a file of its own.
 *
 * - `--trace-opt`: the compilations by Maglev and Turbofan.
 * - `--trace-deopt-verbose`: the deoptimizations, with their positions.
 * - `--trace-turbo-inlining`: Turbofan's candidates for inlining, with their
 *   bytecode sizes, and which it inlined.
 * - `--no-concurrent-recompilation`: compiles on the main thread, so that
 *   one compilation's lines follow one another, and lines don't split. In
 *   Node 27.0.0-alpha, a background compilation's line of inlining was split
 *   by a line of `--trace-opt` from the main thread. V8 then installs
 *   optimized code as soon as it's compiled, rather than at the next check.
 * - `--log-code`: logs each function's name, position and bytecode size, by
 *   the address of its `SharedFunctionInfo`, which the traces name it by.
 */
export const TRACE_FLAGS: readonly string[] = [
    '--trace-opt',
    '--trace-deopt-verbose',
    '--trace-turbo-inlining',
    '--no-concurrent-recompilation',
    '--log-code',
    '--no-logfile-per-isolate'
];

/** The flag that names the file of V8's log, as `--logfile=code.log` */
const LOGFILE = '--logfile=';

/** The file beside the code log that the traced run records source maps in */
const SOURCE_MAPS = 'source-maps.json';

/**
 * d8's warning of a flag that it doesn't know, on stderr, as `Warning:
 * unknown flag --trace-foo.`, which captures the flag as it was given, with
 * any value. d8 then runs without it.
 */
const UNKNOWN_FLAG = /^Warning: unknown flag (--.*?)\.?\r?$/gm;

/** The lines of a failed run's stdout that its error names, at most */
const FAILED_LINES = 20;

/** What a traced run wrote */
export interface TracedOutput {
    /** Its stdout: V8's traces, among what the script wrote */
    readonly output: string;
    /** V8's log of the code that it created */
    readonly codeLog: string;
    /**
     * The source maps that it read of its scripts, by the URLs of their
     * files, before its `bench()` returned, as `recordSourceMaps()` records
     * them
     */
    readonly sourceMapFiles: ReadonlyMap<string, SourceMapFile>;
}

/**
 * Whether this process is the traced run of another, which a process that
 * the traced run starts isn't
 */
export function isTracedRun(): boolean {
    return Boolean(childRunValue(TRACED_RUN));
}

/**
 * The source maps that this traced run read, by the URLs of the scripts'
 * files, which it keeps between its calls of `bench()`, so that it reads
 * each only once
 */
const recorded = new Map<string, SourceMapFile>();

/**
 * In the traced run, reads the source maps of the scripts that V8 has
 * compiled so far, and records them beside the code log, for the process
 * that runs it. That process reads its traces once the run exits, after the
 * script's code after `bench()` has run in it too, which can delete the
 * bundle that it timed.
 *
 * A run without a code log, as one whose environment sets
 * `BENK_TRACED_RUN` without benk, records nothing, and so does a Node built
 * without the inspector, whose process then reads the source maps after it.
 */
export async function recordSourceMaps(): Promise<void> {
    // The last, which `runTraced()` passes after this process's own flags
    const log = process.execArgv
        .findLast(arg => arg.startsWith(LOGFILE))
        ?.slice(LOGFILE.length);
    if (log == null || !process.features.inspector) {
        return;
    }

    const scripts = await compiledScripts();
    const unread = Array.from(scripts).filter(script => !recorded.has(script));
    await Promise.all(unread.map(recordSourceMap));

    await writeFile(
        join(dirname(log), SOURCE_MAPS),
        JSON.stringify(Array.from(recorded))
    );
}

/**
 * The URLs of the scripts that V8 has compiled, as its debugger lists them.
 * The code log names them too, but V8 on Windows keeps the log's file to
 * itself until the process exits, so that it can't be read.
 *
 * The debugger is enabled only for as long as V8 takes to list the scripts.
 * That didn't change what V8 did after it: a script that calls `bench()`
 * twice had the same report with it and without it, in 3 runs of each on
 * Node 24.22.3, 26.13.0 and 27.0.0-alpha, apart from a timer loop whose
 * tiers differed between runs either way.
 */
async function compiledScripts(): Promise<Set<string>> {
    // Imported here, as the module throws in a Node without the inspector
    const { Session } = await import('node:inspector/promises');
    const session = new Session();
    const scripts = new Set<string>();

    session.on('Debugger.scriptParsed', ({ params }) => {
        scripts.add(params.url);
    });
    session.connect();
    try {
        // V8 lists the scripts that it has before it answers
        await session.post('Debugger.enable');
        await session.post('Debugger.disable');
    } finally {
        session.disconnect();
    }

    return scripts;
}

async function recordSourceMap(script: string): Promise<void> {
    recorded.set(script, await readSourceMapFile(script));
}

/**
 * Runs a script in a child Node process with V8's trace flags, and with the
 * flags that this process was started with, which come first so that the
 * trace flags override them. The child's stderr is this process's.
 *
 * @throws {Error} If the child exits with another code than 0, or writes no
 * code log.
 */
export function runTraced(
    script: string,
    args: readonly string[]
): Promise<TracedOutput> {
    return inTemporaryDirectory(async directory => {
        const log = join(directory, 'code.log');
        const output = await runChild({
            name: `the traced run of ${script}`,
            args: [
                ...process.execArgv,
                ...TRACE_FLAGS,
                `${LOGFILE}${log}`,
                script,
                ...args
            ],
            mark: [TRACED_RUN, '1'],
            stdout: 'collect'
        });

        return {
            output,
            codeLog: await readCodeLog(log, 'Node'),
            sourceMapFiles: await readRecorded(join(directory, SOURCE_MAPS))
        };
    });
}

/** A script's run in d8, the V8 shell */
export interface D8Run {
    /** d8's binary: a name that the PATH has, as `d8`, or a path */
    readonly d8: string;
    /** d8's flags, which come before the script */
    readonly flags: readonly string[];
    /** The script's path: an ES module, which d8 loads by its path */
    readonly script: string;
    /** The script's arguments, which d8 passes it after `--` */
    readonly args: readonly string[];
}

/**
 * Runs a script in d8 with V8's trace flags, after the run's own flags, so
 * that the trace flags override them, as `runTraced()` runs one in Node.
 * d8 can't read the environment, so a short script sets a global symbol
 * before the benchmark loads. Its bench() then only measures the groups.
 * d8 has no inspector, so the run records no source maps: they're read
 * after it.
 *
 * d8 writes errors to stdout, and its warnings to stderr, which this
 * collects, apart from this process's stderr.
 *
 * @throws {Error} If d8 can't be started, as when the PATH has no `d8`; if
 * it exits with another code than 0, with what it wrote to stderr and the
 * last lines of stdout, where it writes an uncaught error; if it warns of a
 * trace flag that it doesn't know, as an older d8, or one built without
 * them, may; or if it writes no code log.
 */
export function runTracedInD8({
    d8,
    flags,
    script,
    args
}: D8Run): Promise<TracedOutput> {
    return inTemporaryDirectory(async directory => {
        const log = join(directory, 'code.log');
        const traceFlags = [...TRACE_FLAGS, `${LOGFILE}${log}`];
        const run = await collect(d8, [
            // A user flag such as --module applies to the next script.
            '-e',
            `globalThis[Symbol.for('${D8_TRACED_RUN}')] = true`,
            ...flags,
            ...traceFlags,
            script,
            '--',
            ...args
        ]);

        checkD8Run(run, script, traceFlags);
        return {
            output: run.stdout,
            codeLog: await readCodeLog(log, 'd8'),
            sourceMapFiles: new Map()
        };
    });
}

/** What a process wrote, and how it exited */
interface CollectedRun {
    readonly stdout: string;
    readonly stderr: string;
    /** Its exit code, or the signal that ended it */
    readonly exit: number | NodeJS.Signals | null;
}

/**
 * Checks that d8's traced run exited with 0, and knew each trace flag
 *
 * @throws {Error} If it didn't.
 */
function checkD8Run(
    { stdout, stderr, exit }: CollectedRun,
    script: string,
    traceFlags: readonly string[]
): void {
    if (exit !== 0) {
        const lines = stdout.trimEnd().split(/\r?\n/).slice(-FAILED_LINES);
        throw new Error(
            [
                `Expected the traced run of ${script} in d8 to exit with 0, got ${exit}. Its stderr, and the last lines of its stdout:`,
                stderr.trimEnd(),
                ...lines
            ].join('\n')
        );
    }

    const named = new Set(traceFlags.map(flagName));
    const unknown = Array.from(
        stderr.matchAll(UNKNOWN_FLAG),
        ([, flag]) => flag
    ).filter(flag => named.has(flagName(flag)));
    if (unknown.length > 0) {
        throw new Error(
            `Expected d8 to know each of V8's flags of the traced run, got a warning that it doesn't know ${unknown.join(', ')}: an older d8, or one built without them, may not have them`
        );
    }
}

/** A flag's name, without its value, as `--logfile` of `--logfile=code.log` */
function flagName(flag: string): string {
    const equals = flag.indexOf('=');

    return equals === -1 ? flag : flag.slice(0, equals);
}

/** Which functions `reportTracedRun()` lists, and what its heading names */
export interface TracedReportOptions {
    /** Selects the functions by their names, or none if it lists all */
    readonly filter?: RegExp;
    /**
     * The engine of the traced run, as `d8 15.8.62.9`, or none for a run in
     * this process's Node
     */
    readonly engine?: string;
}

/**
 * The lines of V8's report of a traced run of a script, of the functions
 * that the filter selects, with the positions of its scripts in the
 * sources that their source maps name: those that the run recorded, and
 * those that are read now. The heading names the engine of a run in d8.
 *
 * @throws {Error} If the traces have none of V8's compilations, or the log
 * none of its functions, as when V8 changed their formats.
 */
export async function reportTracedRun(
    script: string,
    traced: TracedOutput,
    options: TracedReportOptions
): Promise<string[]> {
    const { reports, sourceMaps } = await readTracedReport(
        script,
        traced,
        options
    );

    return formatV8Report(reports, {
        ...options,
        script,
        directory: process.cwd(),
        sourceMaps
    });
}

/** What a traced run says, as V8's report reads it */
export interface TracedReport {
    /** V8's traces, placed by the run's markers where they're in order */
    readonly marked: MarkedOutput;
    /** The functions of V8's code log, by their addresses */
    readonly logged: ReadonlyMap<FunctionAddress, LoggedFunction>;
    readonly sourceMaps: SourceMaps;
    /** The functions that the report lists, which the filter selects */
    readonly reports: FunctionReport[];
    /**
     * Whether a script is the benchmark's, or a module that it imports,
     * rather than Node's own, benk's, or code compiled from a string
     */
    readonly isScript: (url: string) => boolean;
}

/**
 * Reads a traced run's traces and code log, and the source maps of its
 * scripts, and lists the functions of the report, as `reportTracedRun()`
 * reports them. The markers of a run in Node place its traces, as
 * `readTracedOutput()` describes. A run in d8 writes none.
 *
 * @throws {Error} If the traces have none of V8's compilations, or the log
 * none of its functions, as when V8 changed their formats.
 */
export async function readTracedReport(
    script: string,
    { output, codeLog, sourceMapFiles }: TracedOutput,
    { filter, engine }: TracedReportOptions
): Promise<TracedReport> {
    const marked = readTracedOutput(output);
    const { trace } = marked;
    const logged = parseCodeLog(codeLog);
    if (trace.compilations.length === 0 || logged.size === 0) {
        // A line that V8 wrote of a compilation, which says what it wrote
        const line = output
            .split('\n')
            .find(text => text.startsWith('[completed compiling'));
        const writer = engine ?? `V8 ${process.versions.v8}`;
        throw new Error(
            `Expected V8's compilations and functions in the traced run of ${script}, got ${trace.compilations.length} and ${logged.size}: ${writer} may write other formats${line == null ? '' : `, as ${line.trimEnd()}`}`
        );
    }

    const sourceMaps = await readSourceMaps(
        tracedScripts(trace, logged),
        sourceMapFiles
    );
    const benk = benkDirectory();
    const reports = reportFunctions(trace, logged, {
        benkDirectory: benk,
        filter,
        sourceMaps
    });

    return {
        marked,
        logged,
        sourceMaps,
        reports,
        isScript: url => isScriptUrl(url, benk)
    };
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

/**
 * The code log of a traced run
 *
 * @throws {Error} If the run wrote none.
 */
async function readCodeLog(path: string, engine: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (isMissing(error)) {
            throw new Error(
                `Expected ${engine} to write V8's code log in the traced run, got none`,
                { cause: error }
            );
        }
        throw error;
    }
}

/**
 * The source maps that the traced run recorded, or none if it didn't, as
 * when its script didn't call `bench()`
 */
async function readRecorded(path: string): Promise<Map<string, SourceMapFile>> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        if (isMissing(error)) {
            return new Map();
        }
        throw error;
    }

    // Written by `recordSourceMaps()`, in the traced run
    return new Map(JSON.parse(text) as Array<[string, SourceMapFile]>);
}

/**
 * Runs a command with the arguments, and collects what it writes to stdout
 * and stderr, and how it exits
 *
 * @throws {Error} If it can't be started.
 */
function collect(
    command: string,
    args: readonly string[]
): Promise<CollectedRun> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout: string[] = [];
        const stderr: string[] = [];

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout.push(chunk);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderr.push(chunk);
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            resolve({
                stdout: stdout.join(''),
                stderr: stderr.join(''),
                exit: code ?? signal
            });
        });
    });
}
