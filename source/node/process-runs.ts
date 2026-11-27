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
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firstBuildIn } from '#source/core/builds';
import type { ProcessRun, RunResult } from '#source/core/types';
import {
    childRunValue,
    inTemporaryDirectory,
    isMissing,
    runChild,
    PROCESS_RUN
} from './child-run.ts';

/**
 * The file of this run of `--processes`, or none or '' if it's no such run,
 * as a process that the run starts isn't
 */
export function processRunFile(): string | undefined {
    return childRunValue(PROCESS_RUN);
}

/**
 * In a run of `--processes`, records the results of a call of `bench()` in
 * the run's file, with those of the calls before it, for the first process
 * to read once the run exits
 */
export function recordProcessRun(
    file: string,
    call: number,
    { date, runtime, groups }: RunResult
): void {
    // One synchronous append per completed call, so overlapping calls
    // can't interleave their records or overwrite an earlier result.
    appendFileSync(
        file,
        JSON.stringify([call, { date, runtime, groups }]) + '\n'
    );
}

/**
 * The runs in other processes so far, each with the results of its calls
 * of `bench()`, by their numbers. Overlapping calls await the same child.
 */
const runs: Array<Promise<readonly ProcessRun[]>> = [];

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
    const results: ProcessRun[] = [];
    for (let i = 0; i < processes - 1; i++) {
        const name = processName(script, i + 2, processes);
        // Reserve this process before awaiting it. Each caller waits for
        // it to finish before it can reserve the next.
        runs[i] ??= runInProcess(name, script, args, i + 2).catch(error => {
            // This child is still the last one. A later call can retry it.
            runs.length = i;
            throw error;
        });
        const calls = await runs[i];
        const result = calls.at(call);
        if (result == null) {
            const made = calls.filter(run => run != null).length;
            throw new Error(
                `Expected ${name} to call bench() ${call + 1} times or more, as this process has, got ${made}`
            );
        }

        results.push(result);
    }

    return results;
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
 * each of its calls of `bench()`. Its number, from 1 for the first, decides
 * which build `compareBuilds()` loads first in it, as `firstBuildIn()`
 * does.
 *
 * @throws {Error} If it exits with another code than 0.
 */
function runInProcess(
    name: string,
    script: string,
    args: readonly string[],
    number: number
): Promise<readonly ProcessRun[]> {
    return inTemporaryDirectory(async directory => {
        const file = join(directory, 'results.jsonl');
        await runChild({
            name,
            args: [...process.execArgv, script, ...args],
            mark: [PROCESS_RUN, file],
            stdout: 'drop',
            firstBuild: firstBuildIn(number)
        });

        return readRecorded(file);
    });
}

/**
 * The results that a run recorded, by call, or none if it recorded none,
 * as when its script didn't call `bench()`
 */
async function readRecorded(file: string): Promise<readonly ProcessRun[]> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if (isMissing(error)) {
            return [];
        }
        throw error;
    }

    // Calls can finish in a different order from the one they started in.
    const calls: ProcessRun[] = [];
    for (const line of text.trimEnd().split('\n')) {
        const [call, result] = JSON.parse(line) as [number, ProcessRun];
        calls[call] = result;
    }

    return calls;
}
