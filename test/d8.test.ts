// d8's entry point, `benk/d8`: its runtime, which times variants in d8, the
// V8 shell, and its `bench()`. The runtime's timer loops run in Node too,
// and so does `bench()` with the arguments, runtime and output that a test
// passes it, where the first tests run them. The runtime's description, its
// count of array buffers, and `bench()`'s defaults, read d8's globals, so
// the others bundle `d8-driver.ts` or `d8-buffers-driver.ts` and run it in
// d8. They need `d8` on the PATH, as `brew install v8` puts it, and are
// skipped without it, as in CI. Times vary, so they check only what
// doesn't.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { build } from 'rolldown';
import { measureGroup, parseOptions, type Group, type RunResult } from 'benk/core';
import { bench, D8Runtime } from 'benk/d8';
import { expectPresent } from './expectations.ts';
import { FakeRuntime } from './fake-runtime.ts';

const QUICK = { sampleTime: 0.2, warmupRounds: 2, rounds: 6 };
const QUICK_ARGS = ['--sample-ms', '0.2', '--warmup-rounds', '2', '--rounds', '6'];

/** The flags of d8 that its runtime's count of array buffers needs */
const BUFFER_FLAGS = ['--allow-natives-syntax', '--expose-gc', '--expose-statistics'];

/** What d8 says of itself, and whether 2³⁰ is a small integer in it */
interface Shell {
    readonly version: string;
    readonly platform: string;
    readonly smallIntegerBits: number;
}

/**
 * Asks d8 for its version and platform, and for the bits of its small
 * integers by `%IsSmi()`, which reads V8's own tag of a value, or returns
 * undefined where d8 isn't installed
 */
function askShell(): Shell | undefined {
    const script = `print(JSON.stringify({
        version: version(),
        platform: os.name,
        smallIntegerBits: %IsSmi(2 ** 30) ? 32 : 31
    }))`;
    const shell = spawnSync('d8', ['--allow-natives-syntax', '-e', script], {
        encoding: 'utf8'
    });

    return shell.error ? undefined : (JSON.parse(shell.stdout) as Shell);
}

/** What a run of `d8-driver.ts` printed, and the file that it wrote */
interface DriverRun {
    readonly stdout: string;
    readonly stderr: string;
    /** The bytes of `results.json` in the run's directory, if it has one */
    readonly results: Buffer | undefined;
}

/** What `d8-driver.ts` prints when `bench()` throws */
interface DriverError {
    readonly error: string;
    readonly calls: number;
}

/** A script that the tests run in d8 */
type Driver = 'd8-driver' | 'd8-buffers-driver';

/** The drivers, each bundled once */
const drivers = new Map<Driver, Promise<string>>();

/**
 * Bundles a driver with benk as this process resolves it, from its source
 * or from its bundle
 */
async function bundleDriver(name: Driver): Promise<string> {
    const { output } = await build({
        input: join(import.meta.dirname, `${name}.ts`),
        platform: 'neutral',
        resolve: {
            alias: {
                'benk/core': fileURLToPath(import.meta.resolve('benk/core')),
                'benk/d8': fileURLToPath(import.meta.resolve('benk/d8'))
            }
        },
        write: false,
        logLevel: 'silent'
    });

    return output[0].code;
}

interface DriverOptions {
    /** `d8-driver.ts` by default */
    readonly driver?: Driver;
    /** d8's own flags, before the script */
    readonly flags?: readonly string[];
    /** The text or bytes of a `results.json` that the directory has before the run */
    readonly results?: string | Uint8Array;
}

/**
 * Runs a driver in d8, in a directory of its own, with d8's flags, and the
 * arguments after `--`, and returns what it printed and wrote
 */
async function runDriver(
    args: readonly string[],
    { driver = 'd8-driver', flags = [], results }: DriverOptions = {}
): Promise<DriverRun> {
    let code = drivers.get(driver);
    if (code == null) {
        code = bundleDriver(driver);
        drivers.set(driver, code);
    }

    const directory = mkdtempSync(join(tmpdir(), 'benk-d8-'));
    const resultsPath = join(directory, 'results.json');
    try {
        writeFileSync(join(directory, 'driver.mjs'), await code);
        if (results != null) {
            writeFileSync(resultsPath, results);
        }

        const run = spawnSync('d8', [...flags, 'driver.mjs', '--', ...args], {
            cwd: directory,
            encoding: 'utf8'
        });

        expect(run.status, run.stderr || run.stdout).toBe(0);
        return {
            stdout: run.stdout,
            stderr: run.stderr,
            results: existsSync(resultsPath) ? readFileSync(resultsPath) : undefined
        };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

/** The error that `d8-driver.ts` printed on the last line of stdout */
function driverError({ stdout }: DriverRun): DriverError {
    const lines = stdout.trimEnd().split('\n');

    return JSON.parse(lines[lines.length - 1]) as DriverError;
}

describe('D8Runtime', () => {
    it.prop([fc.nat({ max: 10_000 })])(
        'calls a variant as often as a loop is told to',
        repetitions => {
            let calls = 0;
            const elapsed = new D8Runtime().createTimer()(() => calls++, repetitions);

            expect(calls).toBe(repetitions);
            expect(elapsed).toBeGreaterThanOrEqual(0);
        }
    );

    it.prop([fc.nat({ max: 1000 })])(
        'awaits each call of an async variant before the next',
        async repetitions => {
            let calls = 0;
            let pending = 0;
            let mostPending = 0;
            const run = async (): Promise<void> => {
                calls++;
                pending++;
                mostPending = Math.max(mostPending, pending);
                await Promise.resolve();
                pending--;
            };

            const elapsed = await new D8Runtime().createAsyncTimer()(run, repetitions);

            expect(calls).toBe(repetitions);
            expect(mostPending).toBe(Math.min(repetitions, 1));
            expect(elapsed).toBeGreaterThanOrEqual(0);
        }
    );

    it.prop([fc.array(fc.boolean(), { minLength: 2, maxLength: 20 })])(
        'gives each loop a source of its own',
        asyncLoops => {
            const runtime = new D8Runtime();
            const sources = asyncLoops.map(async =>
                String(async ? runtime.createAsyncTimer() : runtime.createTimer())
            );

            expect(new Set(sources).size).toBe(sources.length);
        }
    );

    it('times sync and async calls, and counts no bytes outside d8', async () => {
        let count = 0;
        const runtime = new D8Runtime();
        const result = await measureGroup(
            {
                name: 'calls',
                variants: [
                    { name: 'sync', run: () => (count = (count + 1) % 1024) },
                    { name: 'async', async: true, run: () => Promise.resolve(count) }
                ]
            },
            { ...QUICK, runtime }
        );

        expect(runtime.heap).toBeUndefined();
        expect(runtime.arrayBuffers).toBeUndefined();
        for (const { summary, heapBytes, arrayBufferBytes } of result.variants) {
            expect(summary.fastest).toBeGreaterThan(0);
            expect(summary.fastest).toBeLessThan(1e6);
            expect([heapBytes, arrayBufferBytes]).toStrictEqual([null, null]);
        }
        expect(expectPresent(result.timerResolution)).toBeGreaterThan(0);
    });
});

describe('bench of benk/d8', () => {
    const groups = (runtime: FakeRuntime): Group[] => [
        { name: 'first', variants: [runtime.variant('a', 50), runtime.variant('b', 100)] },
        { name: 'second', variants: [runtime.variant('c', 10)] }
    ];
    const FAKE_ARGS = ['--sample-ms', '0.01', '--warmup-rounds', '1', '--rounds', '6'];

    it('prints a description of the run and the table of each group that the filter selects', async () => {
        const runtime = new FakeRuntime();
        const lines: string[] = [];

        const result = await bench(groups(runtime), {
            args: [...FAKE_ARGS, '--filter', 'first'],
            runtime,
            print: line => lines.push(line)
        });

        expect(lines[0]).toMatch(/^Fake 1\.0\.0, none, test none, none\./);
        expect(lines).toContain(
            'first: 6 rounds, by the fastest round (every call under 1 µs and 1 KiB)'
        );
        expect(lines.some(line => line.startsWith('second'))).toBe(false);
        expect(result.groups.map(group => group.name)).toStrictEqual(['first']);
    });

    it.prop(
        [
            fc.integer({ min: 1, max: 8 }),
            fc.integer({ min: 0, max: 2 }),
            fc.constantFrom('0.01', '0.02'),
            fc.option(fc.constantFrom('first', '^s', 'none'), { nil: undefined }),
            fc.boolean(),
            fc.boolean()
        ],
        { numRuns: 20 }
    )(
        'records the options that parseOptions() reads from its arguments',
        async (rounds, warmupRounds, sampleMs, filter, aa, heap) => {
            const runtime = new FakeRuntime();
            const args = [
                `--rounds=${rounds}`,
                '--warmup-rounds',
                String(warmupRounds),
                '--sample-ms',
                sampleMs,
                ...(filter == null ? [] : ['--filter', filter]),
                ...(aa ? [] : ['--no-aa']),
                ...(heap ? [] : ['--no-heap'])
            ];
            const { json, v8Report, v8Filter, ...parsed } = parseOptions(args);

            const result = await bench(groups(runtime), { args, runtime, print: () => undefined });

            expect([json, v8Report, v8Filter]).toStrictEqual([undefined, false, undefined]);
            expect(result.options).toStrictEqual({
                ...parsed,
                filter: parsed.filter?.source ?? ''
            });
        }
    );

    it('counts no bytes with a runtime that counts none, and records it, with or without --no-heap', async () => {
        for (const args of [FAKE_ARGS, [...FAKE_ARGS, '--no-heap']]) {
            const runtime = new FakeRuntime({ heap: false, arrayBuffers: false });
            const lines: string[] = [];

            const result = await bench(groups(runtime), {
                args,
                runtime,
                print: line => lines.push(line)
            });

            expect(result.options.heap, args.join(' ')).toBe(false);
            expect(lines[0].split('\n')[2]).toMatch(/per-round ratios\.$/);
        }
    });

    it('writes the results as JSON for --json -, apart from the tables', async () => {
        const runtime = new FakeRuntime();
        const written: string[] = [];
        const printed: string[] = [];

        const result = await bench(groups(runtime), {
            args: [...FAKE_ARGS, '--json', '-'],
            runtime,
            print: line => printed.push(line),
            write: text => written.push(text)
        });

        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0])).toStrictEqual(result);
        expect(printed.some(line => line.startsWith('second: '))).toBe(true);
    });

    it('rejects --v8-report, --v8-filter and mistaken arguments before it measures', async () => {
        for (const [args, error] of [
            [['--v8-report'], /--v8-report in d8/],
            [['--v8-filter', 'sum'], /--v8-report or --v8-filter in d8/],
            [['--round', '6'], TypeError],
            [['--rounds', '0'], RangeError]
        ] as const) {
            const runtime = new FakeRuntime();
            let calls = 0;
            const counted = { name: 'counted', run: () => calls++ };

            const run = bench([{ name: 'group', variants: [counted] }], {
                args: [...FAKE_ARGS, ...args],
                runtime,
                print: () => undefined
            });

            await expect(run, args.join(' ')).rejects.toThrow(error);
            expect(calls).toBe(0);
        }
    });
});

const shell = askShell();

/** A run of the driver with `--json -`, which tests in d8 share */
let jsonRun: Promise<DriverRun> | undefined;

/** The driver's group of calls, with the results as JSON on stdout */
function runCallsGroup(): Promise<DriverRun> {
    return (jsonRun ??= runDriver([...QUICK_ARGS, '--filter', '^calls$', '--json', '-']));
}

describe.runIf(shell)('benk/d8 in d8', () => {
    it('describes d8, and the bits of its small integers', async () => {
        const { version, platform, smallIntegerBits } = expectPresent(shell);
        const { stdout, stderr } = await runCallsGroup();
        const result = JSON.parse(stdout) as RunResult;

        expect(result.runtime).toStrictEqual({
            name: 'd8',
            version,
            engine: `V8 ${version}`,
            platform,
            arch: 'unknown',
            cpu: 'unknown',
            flags: ['unknown'],
            processState: [`${smallIntegerBits}-bit small integers`]
        });
        expect(stderr.split('\n')[0]).toBe(
            `d8 ${version}, V8 ${version}, ${platform} unknown, unknown, with unknown. Process state: ${smallIntegerBits}-bit small integers.`
        );
    });

    it('times sync and async calls, and prints a table without bytes, to stderr for --json -', async () => {
        const { stdout, stderr } = await runCallsGroup();
        const result = JSON.parse(stdout) as RunResult;
        const [group] = result.groups;
        const lines = stderr.split('\n');
        const rows = group.variants.map(({ name }) =>
            lines.find(line => line.startsWith(`  ${name.padEnd(16)}`))
        );

        expect(result.options).toStrictEqual({
            ...QUICK,
            aa: true,
            heap: false,
            filter: '^calls$'
        });
        expect(group.variants.map(({ name }) => name)).toStrictEqual(['sync', 'async', 'sync A/A']);
        for (const { summary, heapBytes, arrayBufferBytes } of group.variants) {
            expect(summary.fastest).toBeGreaterThan(0);
            expect(summary.fastest).toBeLessThan(1e6);
            expect([heapBytes, arrayBufferBytes]).toStrictEqual([null, null]);
        }
        expect(expectPresent(group.timerResolution)).toBeGreaterThan(0);
        expect(lines[2]).toMatch(/per-round ratios\.$/);
        expect(
            rows.every(row => row != null && /–\s+–$/.test(row)),
            stderr
        ).toBe(true);
    });

    it('writes the results to the file of --json, and the tables to stdout', async () => {
        const run = await runDriver([
            ...QUICK_ARGS,
            '--filter',
            '^calls$',
            '--json',
            'results.json'
        ]);
        const result = JSON.parse(expectPresent(run.results).toString()) as RunResult;

        expect(result.groups.map(({ name }) => name)).toStrictEqual(['calls']);
        expect(run.stdout.split('\n')[0]).toMatch(/^d8 /);
        expect(run.stdout).toContain('\ncalls: ');
        expect(run.stderr).toBe('');
    });

    it('checks the file of --json before it measures, and leaves its text as it was if the run fails', async () => {
        const missing = await runDriver([...QUICK_ARGS, '--json', 'missing/results.json']);
        const failed = await runDriver(
            [...QUICK_ARGS, '--filter', 'throws', '--json', 'results.json'],
            { results: 'earlier' }
        );

        expect(driverError(missing)).toStrictEqual({
            error: 'Error: Expected d8 to write the file of --json, got missing/results.json',
            calls: 0
        });
        expect(driverError(failed).error).toMatch(/throw/);
        expect(failed.results).toStrictEqual(Buffer.from('earlier'));
    });

    it("leaves an earlier file's bytes as they were if the run fails, where they aren't UTF-8", async () => {
        // Bytes that UTF-8 can't start a character with, which a read of the
        // file as text would each take for U+FFFD
        const earlier = Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from('{"old":1}'),
            Buffer.from([0x80, 0x0a])
        ]);
        const failed = await runDriver(
            [...QUICK_ARGS, '--filter', 'throws', '--json', 'results.json'],
            { results: earlier }
        );

        expect(driverError(failed).error).toMatch(/throw/);
        expect(failed.results).toStrictEqual(earlier);
    });

    it('counts the bytes of array buffers with the flags that it needs, and lists them', async () => {
        const { version, platform, smallIntegerBits } = expectPresent(shell);
        const { stdout, stderr } = await runDriver(
            [...QUICK_ARGS, '--filter', '^buffers$', '--json', '-'],
            { flags: BUFFER_FLAGS }
        );
        const result = JSON.parse(stdout) as RunResult;
        const lines = stderr.split('\n');

        expect(result.runtime.flags).toStrictEqual([...BUFFER_FLAGS, 'unknown']);
        expect(result.options.heap).toBe(true);
        expect(
            result.groups[0].variants.map(({ heapBytes, arrayBufferBytes }) => [
                heapBytes,
                arrayBufferBytes
            ])
        ).toStrictEqual([
            [null, 1024],
            [null, 1024]
        ]);
        expect(result.groups[0]).toMatchObject({
            lead: 'median',
            leadReason: 'allocating calls'
        });
        expect(lines[0]).toBe(
            `d8 ${version}, V8 ${version}, ${platform} unknown, unknown, with ${BUFFER_FLAGS.join(' ')} unknown. Process state: ${smallIntegerBits}-bit small integers.`
        );
        expect(lines[2]).toMatch(/in array buffers outside it\.$/);
        expect(lines.find(line => line.startsWith('  Float64Array  '))).toMatch(/–\s+1,024 B$/);
    });

    it('counts no array buffers with --no-heap, or without one of the flags', async () => {
        const runs = [
            { flags: BUFFER_FLAGS, args: ['--no-heap'] },
            ...BUFFER_FLAGS.map(left => ({
                flags: BUFFER_FLAGS.filter(flag => flag !== left),
                args: []
            }))
        ];

        for (const { flags, args } of runs) {
            const { stdout } = await runDriver(
                [...QUICK_ARGS, '--filter', '^buffers$', '--json', '-', ...args],
                { flags }
            );
            const result = JSON.parse(stdout) as RunResult;
            const label = [...flags, ...args].join(' ');

            expect(result.options.heap, label).toBe(false);
            expect(result.groups[0].variants[0].arrayBufferBytes, label).toBeNull();
            expect(result.runtime.flags, label).toStrictEqual(
                args.length > 0 ? [...BUFFER_FLAGS, 'unknown'] : ['unknown']
            );
        }
    });

    it.prop(
        [
            fc.uniqueArray(
                fc.record({
                    length: fc.oneof(
                        fc.integer({ min: 0, max: 128 }),
                        fc.integer({ min: 0, max: 1 << 20 })
                    ),
                    objects: fc.integer({ min: 0, max: 200 })
                }),
                {
                    minLength: 1,
                    maxLength: 4,
                    selector: ({ length, objects }) => `${length}x${objects}`
                }
            )
        ],
        { numRuns: 5 }
    )(
        "counts each call's bytes of array buffers, of more than 64, among scavenges",
        async variants => {
            const { stdout } = await runDriver(
                variants.map(({ length, objects }) => `${length}x${objects}`),
                { driver: 'd8-buffers-driver', flags: BUFFER_FLAGS }
            );
            const result = JSON.parse(stdout) as RunResult;

            expect(
                result.groups[0].variants.map(({ arrayBufferBytes }) => arrayBufferBytes)
            ).toStrictEqual(variants.map(({ length }) => (length > 64 ? length : 0)));
        }
    );

    it('rejects --v8-report before it measures, and names benk-d8, which carries it out', async () => {
        const run = await runDriver([...QUICK_ARGS, '--v8-report', '--json', 'results.json']);

        expect(driverError(run)).toStrictEqual({
            error: "Error: Expected no --v8-report in d8, which can't run the script again: run it with benk-d8, as benk-d8 bench.mjs -- --v8-report",
            calls: 0
        });
        expect(run.results).toBeUndefined();
    });
});
