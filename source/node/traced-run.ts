// The traced run of `--v8-report`: the benchmark script run again, in a
// child Node process, with V8's flags that trace what its compilers do.
// `v8-trace.ts` parses what the run writes, and `v8-report.ts` reports it.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment variable that marks the traced run. `bench()` measures in
 * it as in any other run, so that V8 sees the same calls, but prints
 * nothing, writes no JSON, and doesn't run the script again for
 * `--v8-report`.
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

/** What a traced run wrote */
export interface TracedOutput {
    /** Its stdout: V8's traces, among what the script wrote */
    readonly output: string;
    /** V8's log of the code that it created */
    readonly codeLog: string;
}

/** Whether this process is the traced run of another */
export function isTracedRun(): boolean {
    return Boolean(process.env[TRACED_RUN]);
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
            `--logfile=${log}`,
            script,
            ...args
        ]);

        return { output, codeLog: await readFile(log, 'utf8') };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
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
