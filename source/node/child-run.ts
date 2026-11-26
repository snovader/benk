// A benchmark script run again in a child Node process, which the traced
// run of `--v8-report` and the runs of `--processes` share: with the flags
// that this process was started with, the script's arguments, and an
// environment variable that tells the child's `bench()` what the run is for.
// The child's stderr is this process's, so that its errors show.
//
// A process that the script starts inherits its environment, with the run's
// variable, as when a script runs itself again with `spawnSync()`. So the
// child takes the variable as its own only if the process that set it is its
// parent, which `BENK_PARENT_PID` names: a process that the child starts is
// an ordinary run, which prints, and writes to no file of this process's.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment variable of a child run that names the process that
 * started it, by its pid
 */
const PARENT = 'BENK_PARENT_PID';

/** A run of a script in a child Node process */
export interface ChildRun {
    /** What the run is, as an error names it: `the traced run of bench.ts` */
    readonly name: string;
    /** Node's arguments: its flags, then the script and its arguments */
    readonly args: readonly string[];
    /** The environment variable that marks the run, and its value */
    readonly mark: readonly [variable: string, value: string];
    /** Whether to collect what the child writes to stdout, or to drop it */
    readonly stdout: 'collect' | 'drop';
}

/**
 * Runs Node with the arguments, in this process's environment with the
 * run's variable and this process's pid, and returns what it wrote to
 * stdout, or '' where it's dropped
 *
 * @throws {Error} If the child exits with another code than 0.
 */
export function runChild({
    name,
    args,
    mark: [variable, value],
    stdout
}: ChildRun): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            env: {
                ...process.env,
                [variable]: value,
                [PARENT]: String(process.pid)
            },
            stdio: [
                'ignore',
                stdout === 'collect' ? 'pipe' : 'ignore',
                'inherit'
            ]
        });
        const chunks: string[] = [];

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            chunks.push(chunk);
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (code === 0) {
                resolve(chunks.join(''));
            } else {
                reject(
                    new Error(
                        `Expected ${name} to exit with 0, got ${code ?? signal}`
                    )
                );
            }
        });
    });
}

/**
 * The value of a child run's variable, if this process is that run, or else
 * undefined: if the process that `runChild()` started was this one's parent
 */
export function childRunValue(variable: string): string | undefined {
    const parent = process.env[PARENT];
    if (!parent || Number(parent) !== process.ppid) {
        return undefined;
    }

    return process.env[variable];
}

/**
 * Runs a function with a temporary directory, which it removes after, as a
 * child run writes files there for this process
 */
export async function inTemporaryDirectory<T>(
    use: (directory: string) => Promise<T>
): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'benk-'));
    try {
        return await use(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** Whether an error is of a file that's missing */
export function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
