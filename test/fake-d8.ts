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
//
// With `FAKE_D8_ARGS`, it appends its arguments to that file, as a line of
// JSON for each run.
import { appendFileSync, writeFileSync } from 'node:fs';
import { fixture, D8_VERSION } from './v8-fixtures.ts';

/** What d8 prints of an uncaught error, on stdout */
const ERROR = [
    '/project/bench.mjs:2: Error: boom',
    'Error: boom',
    '    at /project/bench.mjs:2:7'
];

const LOGFILE = '--logfile=';

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
} else {
    console.log('d8 ran the script');
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
