// The traced run of `--v8-report`: the benchmark script run again, in a
// child Node process, with V8's flags that trace what its compilers do.
// `v8-trace.ts` parses what the run writes, and `v8-report.ts` reports it.
// The run records the source maps of its scripts before its `bench()`
// returns, as `source-maps.ts` reads them.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSourceMapFile, type SourceMapFile } from './source-maps.ts';
import { parseCodeLog } from './v8-trace.ts';

/**
 * The environment variable that marks the traced run. `bench()` measures in
 * it as in any other run, so that V8 sees the same calls, but prints
 * nothing, writes no JSON, and doesn't run the script again for
 * `--v8-report`. It then records the source maps of the run's scripts.
 */
export const TRACED_RUN = 'BENK_TRACED_RUN';

/**
 * V8's flags of the traced run. The traces go to stdout, among what the
 * script writes there, and the code log to a file of its own.
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

/** What a traced run wrote */
export interface TracedOutput {
    /** Its stdout: V8's traces, among what the script wrote */
    readonly output: string;
    /** V8's log of the code that it created */
    readonly codeLog: string;
    /**
     * The source maps that it read of the scripts of its code log, by
     * script, before its `bench()` returned, as `recordSourceMaps()` records
     * them
     */
    readonly sourceMapFiles: ReadonlyMap<string, SourceMapFile>;
}

/** Whether this process is the traced run of another */
export function isTracedRun(): boolean {
    return Boolean(process.env[TRACED_RUN]);
}

/**
 * The source maps that this traced run read, by script, which it keeps
 * between its calls of `bench()`, so that it reads each only once
 */
const recorded = new Map<string, SourceMapFile>();

/**
 * In the traced run, reads the source maps of the scripts that its code log
 * names so far, and records them beside the log, for the process that runs
 * it. That process reads its traces once the run exits, after the script's
 * code after `bench()` has run in it too, which can delete the bundle that
 * it timed. A run without a code log, as one whose environment sets
 * `BENK_TRACED_RUN` without benk, records nothing.
 */
export async function recordSourceMaps(): Promise<void> {
    // The last, which `runTraced()` passes after this process's own flags
    const log = process.execArgv
        .findLast(arg => arg.startsWith(LOGFILE))
        ?.slice(LOGFILE.length);
    if (log == null) {
        return;
    }

    const logged = parseCodeLog(await readFile(log, 'utf8'));
    const scripts = new Set<string>();
    for (const { position } of logged.values()) {
        if (!recorded.has(position.url)) {
            scripts.add(position.url);
        }
    }
    await Promise.all(Array.from(scripts, recordSourceMap));

    await writeFile(
        join(dirname(log), SOURCE_MAPS),
        JSON.stringify(Array.from(recorded))
    );
}

async function recordSourceMap(script: string): Promise<void> {
    recorded.set(script, await readSourceMapFile(script));
}

/**
 * Runs a script in a child Node process with V8's trace flags, and with the
 * flags that this process was started with, which come first so that the
 * trace flags override them. The child's stderr is this process's.
 *
 * @throws {Error} If the child exits with another code than 0.
 */
export async function runTraced(
    script: string,
    args: readonly string[]
): Promise<TracedOutput> {
    const directory = await mkdtemp(join(tmpdir(), 'benk-'));
    try {
        const log = join(directory, 'code.log');
        const output = await runChild(script, [
            ...process.execArgv,
            ...TRACE_FLAGS,
            `${LOGFILE}${log}`,
            script,
            ...args
        ]);

        return {
            output,
            codeLog: await readFile(log, 'utf8'),
            sourceMapFiles: await readRecorded(join(directory, SOURCE_MAPS))
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
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

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Runs Node with the arguments, and collects what it writes to stdout */
function runChild(script: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            env: { ...process.env, [TRACED_RUN]: '1' },
            stdio: ['ignore', 'pipe', 'inherit']
        });
        const chunks: string[] = [];

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            chunks.push(chunk);
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (code === 0) {
                resolve(chunks.join(''));
            } else {
                reject(
                    new Error(
                        `Expected the traced run of ${script} to exit with 0, got ${code ?? signal}`
                    )
                );
            }
        });
    });
}
