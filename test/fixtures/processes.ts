// A benchmark script for the tests of `--processes`, which the fake runtime
// times, so that a test knows each variant's ratio in each process. Its runs
// count themselves in the file that `PROCESSES_RUNS` names, a line each,
// and print their number to stdout, which only the first process's shows.
// It calls `bench()` twice:
//
// - `pairs`: `slower` takes 100 ns a call in the first run, and 10 ns more
//   in each run after it, and `faster` 20 ns in each, against `base`'s
//   50 ns.
// - `crossing`: `grows` takes 25 ns a call in the first run, and 25 ns
//   more in each run after it, against `base`'s 50 ns.
//
// With `PROCESSES_FAULT`, the second run goes wrong: `fails` throws before
// it measures, and `renames` measures `pairs` under another name.
import { appendFileSync, readFileSync } from 'node:fs';
import { bench } from 'benk';
import { FakeRuntime } from '#test/fake-runtime';

const counter = process.env.PROCESSES_RUNS ?? '';
const run = runsBefore(counter);
appendFileSync(counter, 'run\n');
console.log(`run ${run + 1}`);

const fault = run === 1 ? process.env.PROCESSES_FAULT : undefined;
if (fault === 'fails') {
    throw new Error('The second run fails');
}

const runtime = new FakeRuntime();

await bench(
    [
        {
            name: fault === 'renames' ? 'renamed' : 'pairs',
            variants: [
                runtime.variant('base', 50),
                runtime.variant('slower', 100 + 10 * run),
                runtime.variant('faster', 20)
            ]
        }
    ],
    { runtime }
);

await bench(
    [
        {
            name: 'crossing',
            variants: [
                runtime.variant('base', 50),
                runtime.variant('grows', 25 * (run + 1))
            ]
        }
    ],
    { runtime }
);

/** The runs that the counter has counted, before this one */
function runsBefore(file: string): number {
    try {
        return readFileSync(file, 'utf8').split('\n').length - 1;
    } catch {
        // The first run, before which there's no file
        return 0;
    }
}
