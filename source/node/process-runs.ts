// The runs of `--processes`: the benchmark script run again in other Node
// processes, after the first has measured, one after another, so that they
// don't load each other. Each process measures as the first did, and has
// its own V8's tiering decisions, heap layout and order of loading, which
// the rounds of one process share. A run records its results in a file of
// the first process's, which the environment variable `BENK_PROCESS_RUN`
// names, rather than on stdout, where the script may write too.
//
// A run runs the whole script, with each of its calls of `bench()`, so
// that each call measures in a process whose earlier calls measured as the
// first process's did. A later call of `bench()` in the first process takes
// its results from the same runs, rather than running the script again.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessRun, RunResult } from '#source/core/types';
import {
    childRunValue,
    inTemporaryDirectory,
    isMissing,
    runChild
} from './child-run.ts';

/**
 * The environment variable that marks a run of `--processes`, whose value
 * is the file to record its results in. `bench()` measures in it as in the
 * first run, but prints nothing, writes no JSON, and runs the script in no
 * other process, for `--processes` or `--v8-report`.
 */
export const PROCESS_RUN = 'BENK_PROCESS_RUN';

/**
 * The file of this run of `--processes`, or none or '' if it's no such run,
 * as a process that the run starts isn't
 */
export function processRunFile(): string | undefined {
    return childRunValue(PROCESS_RUN);
}

/** The results that this run recorded, by the number of their call */
const recorded: ProcessRun[] = [];

/**
 * In a run of `--processes`, records the results of a call of `bench()` in
 * the run's file, with those of the calls before it, for the first process
 * to read once the run exits
 */
export async function recordProcessRun(
    file: string,
    call: number,
    { date, runtime, groups }: RunResult
): Promise<void> {
    recorded[call] = { date, runtime, groups };
    await writeFile(file, JSON.stringify(recorded));
}

/**
 * The runs in other processes so far, each with the results of its calls
 * of `bench()`, by their numbers, or null for a call that recorded none
 */
const runs: Array<ReadonlyArray<ProcessRun | null>> = [];

/** Which call of `bench()` `runInProcesses()` takes the results of */
export interface ProcessesOptions {
    /** The number of the call in the process, from 0 */
    readonly call: number;
    /** The processes in all, this one with them */
    readonly processes: number;
}

/**
 * Runs the script in other processes, one after another, with this
 * process's flags and the arguments, and returns the results of a call of
 * `bench()` in each. A later call takes its results from the same runs, and
 * runs only the processes that earlier calls didn't.
 *
 * @throws {Error} If a run exits with another code than 0, or didn't
 * record the call, as when its script called `bench()` fewer times.
 */
export async function runInProcesses(
    script: string,
    args: readonly string[],
    { call, processes }: ProcessesOptions
): Promise<ProcessRun[]> {
    while (runs.length < processes - 1) {
        const name = processName(script, runs.length + 2, processes);
        runs.push(await runInProcess(name, script, args));
    }

    return runs.slice(0, processes - 1).map((calls, i) => {
        const result = calls.at(call);
        if (result == null) {
            const name = processName(script, i + 2, processes);
            const made = calls.filter(run => run != null).length;
            throw new Error(
                `Expected ${name} to call bench() ${call + 1} times or more, as this process has, got ${made}`
            );
        }

        return result;
    });
}

/** A run of the script in another process, as an error names it */
function processName(
    script: string,
    number: number,
    processes: number
): string {
    return `the run of ${script} in process ${number} of ${processes}`;
}

/**
 * Runs the script in another process, without its stdout, where the script
 * may write what the first process's run wrote, and returns the results of
 * each of its calls of `bench()`
 *
 * @throws {Error} If it exits with another code than 0.
 */
function runInProcess(
    name: string,
    script: string,
    args: readonly string[]
): Promise<ReadonlyArray<ProcessRun | null>> {
    return inTemporaryDirectory(async directory => {
        const file = join(directory, 'results.json');
        await runChild({
            name,
            args: [...process.execArgv, script, ...args],
            mark: [PROCESS_RUN, file],
            stdout: 'drop'
        });

        return readRecorded(file);
    });
}

/**
 * The results that a run recorded, by call, or none if it recorded none,
 * as when its script didn't call `bench()`
 */
async function readRecorded(
    file: string
): Promise<ReadonlyArray<ProcessRun | null>> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if (isMissing(error)) {
            return [];
        }
        throw error;
    }

    // Written by `recordProcessRun()`, which writes a missing call as null
    return JSON.parse(text) as Array<ProcessRun | null>;
}
