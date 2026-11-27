// A stand-in for d8, which `benk-d8.test.ts` runs benk-d8 with, so that
// the tests of what benk-d8 does with d8's output run without d8, as in CI.
// It tells the traced run from the first by its `--log-code`, and does what
// the environment variable `FAKE_D8` says:
//
// - `replay`, by default: the first run prints a line. The traced run
//   prints the traces of the fixtures' run in d8, and writes their code log
//   to the file of `--logfile=`, as d8 would.
// - `unknown-flag`: as `replay`, but the traced run warns, as d8 does, that
//   it doesn't know `--trace-turbo-inlining`.
// - `no-log`: as `replay`, but the traced run writes no code log.
// - `other-formats`: the traced run prints and logs nothing that V8 15.8
//   would.
// - `fails`: each run prints an error to stdout, as d8 does, and exits
//   with 1.
// - `fails-traced`: as `replay`, but the traced run prints an error, and
//   exits with 1.
// - `measures`: as `replay`, but a run other than the traced one measures a
//   group with the fake runtime, as `benk/d8`'s `bench()` would, and writes
//   its results to the file of the script's `--json`. The group's `other`
//   takes 100 ns a call in the first run, and 10 ns more in each after it,
//   against `base`'s 50 ns, as the runs recorded in `FAKE_D8_ARGS` count.
// - `measures-then-fails`: as `measures`, but each run after the first
//   prints an error, and exits with 1.
// - `compares`: a run other than the traced one runs the scripts that `-e`
//   gives it, and then `benk/d8`'s `compareBuilds()` on the builds of
//   `fixtures/builds/`, with the fake runtime, and with d8's globals that
//   it prints and writes files with, as d8 would run a script that compares
//   them.
//
// With `FAKE_D8_ARGS`, it appends its arguments to that file, as a line of
// JSON for each run.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { formatJson, measureGroups } from 'benk';
import { FakeRuntime } from './fake-runtime.ts';
import type * as Builds from './fixtures/builds/base.ts';
import { fixture, D8_VERSION } from './v8-fixtures.ts';

/** What d8 prints of an uncaught error, on stdout */
const ERROR = [
    '/project/bench.mjs:2: Error: boom',
    'Error: boom',
    '    at /project/bench.mjs:2:7'
];

const LOGFILE = '--logfile=';

type Build = typeof Builds;

const args = process.argv.slice(2);
const mode = process.env.FAKE_D8 ?? 'replay';
const recorded = process.env.FAKE_D8_ARGS;
if (recorded != null) {
    appendFileSync(recorded, `${JSON.stringify(args)}\n`);
}

if (mode === 'fails') {
    fail();
} else if (args.includes('--log-code')) {
    trace();
} else if (mode.startsWith('measures')) {
    await measure();
} else if (mode === 'compares') {
    await compare();
} else {
    console.log('d8 ran the script');
}

/** Measures as the mode `measures` says, or fails after the first run */
async function measure(): Promise<void> {
    // This run's line is the last that the file has
    const before =
        readFileSync(recorded ?? '', 'utf8')
            .trimEnd()
            .split('\n').length - 1;
    if (before > 0 && mode === 'measures-then-fails') {
        fail();
        return;
    }

    const options = args.slice(args.indexOf('--') + 1);
    const json = options[options.indexOf('--json') + 1];
    const nanoseconds = 100 + 10 * before;
    const runtime = new FakeRuntime();
    const result = await measureGroups(
        [
            {
                name: 'pair',
                variants: [
                    runtime.variant('base', 50),
                    runtime.variant('other', nanoseconds)
                ]
            }
        ],
        { rounds: 6, warmupRounds: 1, sampleTime: 0.01, runtime }
    );

    console.log(`d8 measured other in ${nanoseconds} ns`);
    writeFileSync(json, formatJson(result));
}

/**
 * Runs `compareBuilds()` of `benk/d8` as d8 runs a script that calls it:
 * after the scripts of `-e`, with d8's globals, and the script's options
 */
async function compare(): Promise<void> {
    for (const [i, arg] of args.entries()) {
        if (arg === '-e') {
            // oxlint-disable-next-line typescript/no-implied-eval -- d8 runs the script that -e gives it
            (new Function(args[i + 1]) as () => void)();
        }
    }
    Object.assign(globalThis, {
        print: (line: string) => console.log(line),
        printErr: (line: string) => console.error(line),
        write: (text: string) => process.stdout.write(text),
        writeFile: (path: string, data: string | ArrayBuffer) =>
            writeFileSync(
                path,
                typeof data === 'string' ? data : new Uint8Array(data)
            ),
        readbuffer: (path: string) => new Uint8Array(readFileSync(path)).buffer
    });

    const { compareBuilds } = await import('benk/d8');
    const runtime = new FakeRuntime();
    await compareBuilds(
        (build: Build) => [
            {
                name: 'calls',
                variants: [
                    runtime.variant('sum', build.NANOSECONDS.sum),
                    runtime.variant('sort', build.NANOSECONDS.sort)
                ]
            }
        ],
        { args: args.slice(args.indexOf('--') + 1), runtime }
    );
}

/** Writes what d8 writes in a traced run, as the mode says */
function trace(): void {
    const log = args
        .findLast(arg => arg.startsWith(LOGFILE))
        ?.slice(LOGFILE.length);

    if (mode === 'unknown-flag') {
        console.error(
            'Warning: unknown flag --trace-turbo-inlining.\nTry --help for options'
        );
    }
    if (mode === 'other-formats') {
        console.log('[optimized sum at tier 4]');
        writeFileSync(log ?? '', 'v8-version,15,8,62,9,0\n');
        return;
    }

    process.stdout.write(fixture(D8_VERSION, 'trace.txt', 'd8'));
    if (mode !== 'no-log') {
        writeFileSync(log ?? '', fixture(D8_VERSION, 'code.log', 'd8'));
    }
    if (mode === 'fails-traced') {
        fail();
    }
}

function fail(): void {
    console.log(ERROR.join('\n'));
    process.exitCode = 1;
}
