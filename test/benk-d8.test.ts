// benk-d8, the command that runs a benchmark script in d8 from Node, run as
// a user runs it: its source, or the bundle that `yarn test:dist` tests. The
// tests of its command line, and of a d8 that isn't there, run everywhere.
// The tests of what it does with d8's output run `fake-d8.ts` in d8's place,
// through a shell script, which Windows can't run, so they're skipped there.
// The tests in d8 itself need `d8` on the PATH, as `brew install v8` puts
// it, and are skipped without it, as in CI. Times vary, so they check only
// what doesn't.
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { build } from 'rolldown';
import { parseOptions, type RunResult } from 'benk';
import { TRACE_FLAGS } from '#source/node/traced-run';
import { BENCH, D8_BUNDLE, D8_VERSION, REPOSITORY } from './v8-fixtures.ts';

/**
 * benk-d8's entry point, beside `benk`'s, as the tests run the package: its
 * source, or its bundle
 */
const BENK_D8 = fileURLToPath(
    new URL(
        import.meta.resolve('benk').endsWith('.ts') ? 'benk-d8.ts' : 'benk-d8.js',
        import.meta.resolve('benk')
    )
);

/** What a run of benk-d8 wrote, and its exit code */
interface CommandRun {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Runs benk-d8 with the arguments, from the repository's directory, as the
 * package's scripts run the tests
 */
async function runCommand(
    args: readonly string[],
    env: NodeJS.ProcessEnv = {}
): Promise<CommandRun> {
    try {
        const { stdout, stderr } = await promisify(execFile)(
            process.execPath,
            ['--no-strip-types', '--import', '@snovader/node-hooks/register', BENK_D8, ...args],
            { cwd: REPOSITORY, env: { ...process.env, ...env } }
        );
        return { status: 0, stdout, stderr };
    } catch (error) {
        const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
        return { status: code, stdout, stderr };
    }
}

/** A temporary directory, for a test to write in, which it removes after */
async function inDirectory<T>(use: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'benk-d8-'));
    try {
        return await use(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** The lines of a report, from its heading */
function reportOf(output: string): string[] {
    const lines = output.split(/\r?\n/);
    const heading = lines.findIndex(line => line.startsWith('V8 report of '));
    expect(heading, output).not.toBe(-1);

    return lines.slice(heading);
}

describe('benk-d8', () => {
    it('reads the script and its options before it runs d8, and says what is wrong', async () => {
        const missing = '--d8=/nowhere/d8';

        for (const [args, error] of [
            [
                [missing],
                'TypeError: Expected a script to run in d8, as benk-d8 bench.mjs -- --v8-report, got none'
            ],
            [
                [missing, D8_BUNDLE, '--rounds', '6'],
                'TypeError: Expected -- after the script, before its options, as d8 takes them, got --rounds'
            ],
            [[missing, D8_BUNDLE, '--', '--round', '6'], 'TypeError: Expected an option, one of'],
            [
                [missing, D8_BUNDLE, '--', '--rounds', '0'],
                'RangeError: Expected --rounds to be an integer of at least 1, got 0'
            ],
            [
                ['--d8', D8_BUNDLE],
                "TypeError: Expected the path of d8's binary in --d8=<path>, got --d8"
            ],
            [
                ['--d8=', D8_BUNDLE],
                "TypeError: Expected the path of d8's binary in --d8=<path>, got --d8="
            ],
            [
                [missing, D8_BUNDLE, '--', '--v8-check'],
                "Error: Expected no --v8-check in benk-d8: V8's check needs Node's traced run"
            ],
            [
                [missing, D8_BUNDLE, '--', '--v8-max-bytecode', '400'],
                'Error: Expected no --v8-max-bytecode in benk-d8'
            ],
            [
                [missing, D8_BUNDLE, '--', '--processes', '2', '--json', '/nowhere/results.json'],
                'Error: Expected the directory of --json to be writable, got '
            ]
        ] as const) {
            const { status, stdout, stderr } = await runCommand(args);

            expect(status, args.join(' ')).toBe(1);
            expect(stderr, args.join(' ')).toContain(`benk-d8: ${error}`);
            expect(stdout).toBe('');
        }
    });

    it('says how to get d8, when it has none to run', async () => {
        const { status, stderr } = await runCommand([
            '--d8=/nowhere/d8',
            D8_BUNDLE,
            '--',
            '--v8-report'
        ]);

        expect(status).toBe(1);
        expect(stderr.trimEnd()).toBe(
            "benk-d8: Error: Expected to run d8, V8's shell, as /nowhere/d8, got ENOENT: install it, as with brew install v8, or give the path of its binary with --d8=<path>"
        );
    });
});

/**
 * Runs benk-d8 with `fake-d8.ts` as d8, in a mode of its own, and returns
 * what it wrote, and the arguments of each run of d8
 */
async function runFake(
    mode: string,
    args: readonly string[]
): Promise<CommandRun & { readonly d8Runs: string[][] }> {
    return inDirectory(async directory => {
        const d8 = join(directory, 'd8');
        const recorded = join(directory, 'args.jsonl');
        const fake = join(import.meta.dirname, 'fake-d8.ts');
        await writeFile(
            d8,
            `#!/bin/sh\nexec '${process.execPath}' --no-strip-types --import @snovader/node-hooks/register '${fake}' "$@"\n`
        );
        await chmod(d8, 0o755);

        const run = await runCommand([`--d8=${d8}`, ...args], {
            FAKE_D8: mode,
            FAKE_D8_ARGS: recorded
        });
        const lines = (await readFile(recorded, 'utf8')).trimEnd().split('\n');
        return { ...run, d8Runs: lines.map(line => JSON.parse(line) as string[]) };
    });
}

/** A value of each option of the script's that takes one, which it accepts */
const VALUES: Readonly<Record<string, readonly string[]>> = {
    rounds: ['6', '31'],
    'warmup-rounds': ['0', '2'],
    'sample-ms': ['0.5', '2'],
    filter: ['^sums$', 'a=b'],
    json: ['-', 'results.json'],
    'v8-filter': ['^sum$', '-x']
};

/** One of the script's options, in each form that it takes */
const scriptOption = fc.oneof(
    fc
        .tuple(fc.boolean(), fc.constantFrom('aa', 'heap', 'v8-report'))
        .map(([negated, flag]) => [`--${negated ? 'no-' : ''}${flag}`]),
    fc
        .constantFrom(...Object.keys(VALUES))
        .chain(name => fc.tuple(fc.constant(name), fc.constantFrom(...VALUES[name]), fc.boolean()))
        .map(([name, text, inline]) =>
            inline || text.startsWith('-') ? [`--${name}=${text}`] : [`--${name}`, text]
        )
);

describe.skipIf(process.platform === 'win32')('benk-d8 with d8 faked', () => {
    it.prop([fc.array(scriptOption, { maxLength: 6 }).map(options => options.flat())], {
        numRuns: 10
    })(
        "passes d8 the script's options after --, and the traced run those that change what's measured",
        async options => {
            const flags = ['--max-inlined-bytecode-size=100', '--harmony-temporal'];
            const parsed = parseOptions(options);
            const report = { v8Report: false, v8Filter: undefined };

            const { status, stderr, d8Runs } = await runFake('replay', [
                ...flags,
                D8_BUNDLE,
                '--',
                ...options
            ]);
            const [first, traced] = d8Runs.map(args => ({
                flags: args.slice(0, args.indexOf(D8_BUNDLE)),
                options: parseOptions(args.slice(args.indexOf(D8_BUNDLE) + 2))
            }));

            expect(status, stderr).toBe(0);
            expect(d8Runs).toHaveLength(parsed.v8Report ? 2 : 1);
            expect(first).toStrictEqual({ flags, options: { ...parsed, ...report } });
            if (traced != null) {
                expect(traced.flags.slice(0, -1)).toStrictEqual([...flags, ...TRACE_FLAGS]);
                expect(traced.flags.at(-1)).toMatch(/^--logfile=.+code\.log$/);
                expect(traced.options).toStrictEqual({ ...parsed, ...report, json: undefined });
            }
        }
    );

    it("prints V8's report of the traced run after d8's output, and names d8's version", async () => {
        const { status, stdout } = await runFake('replay', [
            D8_BUNDLE,
            '--',
            '--v8-filter',
            '^sum$'
        ]);

        expect(status).toBe(0);
        expect(stdout.split('\n')[0]).toBe('d8 ran the script');
        expect(reportOf(stdout)).toStrictEqual([
            `V8 report of ${D8_BUNDLE}, from a run of it in d8 ${D8_VERSION} with V8's traces, whose times aren't reported.`,
            "Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.",
            'Only the functions whose names match ^sum$.',
            `sum ${BENCH}:19:13, 37 B of bytecode`,
            '  compiled to Maglev ×3, Turbofan ×3',
            `  inlined into run ${BENCH}:98:22 ×2`,
            `  deoptimized in Turbofan's code: wrong map (eager), at ${BENCH}:21:32 ×2`,
            ''
        ]);
    });

    it('prints the report to stderr for --json -, as the tables go there', async () => {
        const { status, stdout, stderr } = await runFake('replay', [
            D8_BUNDLE,
            '--',
            '--json',
            '-',
            '--v8-report'
        ]);

        expect(status).toBe(0);
        expect(stdout).toBe('d8 ran the script\n');
        expect(reportOf(stderr)[0]).toMatch(/^V8 report of /);
    });

    it("exits with d8's code, and traces nothing, when the script fails in d8", async () => {
        const { status, stdout, stderr, d8Runs } = await runFake('fails', [
            D8_BUNDLE,
            '--',
            '--v8-report'
        ]);

        expect(status).toBe(1);
        expect(stdout).toContain('Error: boom');
        expect(stdout).not.toContain('V8 report');
        expect(stderr).toBe('');
        expect(d8Runs).toHaveLength(1);
    });

    it('throws for a traced run that fails, with the end of its output', async () => {
        const { status, stdout, stderr } = await runFake('fails-traced', [
            D8_BUNDLE,
            '--',
            '--v8-report'
        ]);

        expect(status).toBe(1);
        expect(stdout).not.toContain('V8 report');
        expect(stderr).toMatch(
            new RegExp(
                `^benk-d8: Error: Expected the traced run of ${D8_BUNDLE} in d8 to exit with 0, got 1\\.`
            )
        );
        expect(stderr).toContain('\nError: boom\n    at /project/bench.mjs:2:7\n');
    });

    it("throws for a d8 that doesn't know a trace flag, rather than report without it", async () => {
        const { status, stdout, stderr } = await runFake('unknown-flag', [
            D8_BUNDLE,
            '--',
            '--v8-report'
        ]);

        expect(status).toBe(1);
        expect(stdout).not.toContain('V8 report');
        expect(stderr.trimEnd()).toBe(
            "benk-d8: Error: Expected d8 to know each of V8's flags of the traced run, got a warning that it doesn't know --trace-turbo-inlining: an older d8, or one built without them, may not have them"
        );
    });

    it('throws for a traced run without a code log, or without traces that it reads', async () => {
        const noLog = await runFake('no-log', [D8_BUNDLE, '--', '--v8-report']);
        const otherFormats = await runFake('other-formats', [D8_BUNDLE, '--', '--v8-report']);

        expect([noLog.status, otherFormats.status]).toStrictEqual([1, 1]);
        expect(noLog.stderr.trimEnd()).toBe(
            "benk-d8: Error: Expected d8 to write V8's code log in the traced run, got none"
        );
        expect(otherFormats.stderr.trimEnd()).toBe(
            `benk-d8: Error: Expected V8's compilations and functions in the traced run of ${D8_BUNDLE}, got 0 and 0: d8 15.8.62.9 may write other formats`
        );
    });

    it("runs d8 in each process, and prints the ratios across them after the first run's output", async () => {
        await inDirectory(async directory => {
            const path = join(directory, 'results.json');
            const { status, stdout, stderr, d8Runs } = await runFake('measures', [
                D8_BUNDLE,
                '--',
                '--rounds',
                '6',
                '--processes',
                '3',
                '--json',
                path
            ]);
            const result = JSON.parse(await readFile(path, 'utf8')) as RunResult;
            const options = d8Runs.map(args =>
                parseOptions(args.slice(args.indexOf(D8_BUNDLE) + 2))
            );
            const lines = stdout.split('\n');
            const row = lines.find(line => line.startsWith('  other '));

            expect(status, stderr).toBe(0);
            // Each run gets the script's options, but --processes, and a file of its own
            expect(options.map(({ rounds, processes }) => [rounds, processes])).toStrictEqual([
                [6, 1],
                [6, 1],
                [6, 1]
            ]);
            expect(new Set(options.map(({ json }) => json)).size).toBe(3);
            expect(options.map(({ json }) => json)).not.toContain(path);
            // Only the first run's output shows
            expect(lines.filter(line => line.startsWith('d8 measured'))).toStrictEqual([
                'd8 measured other in 100 ns'
            ]);
            expect(lines).toContain('pair: 3 processes, by the fastest round');
            expect(row?.trim().split(/\s+/)).toStrictEqual([
                'other',
                '2.00×',
                '2.20×',
                '2.40×',
                '2.20×',
                '2.00–2.40'
            ]);
            expect(result.processes?.runs).toHaveLength(2);
            expect(result.processes?.groups[0].variants[1].median).toBeCloseTo(2.2);
        });
    });

    it('writes the results with the other processes to stdout for --json -, and the rest to stderr', async () => {
        const { status, stdout, stderr } = await runFake('measures', [
            D8_BUNDLE,
            '--',
            '--processes',
            '2',
            '--json',
            '-'
        ]);
        const result = JSON.parse(stdout) as RunResult;

        expect(status, stderr).toBe(0);
        expect(result.processes?.runs).toHaveLength(1);
        expect(stderr).toContain('d8 measured other in 100 ns\n');
        expect(stderr).toContain('\npair: 2 processes, by the fastest round\n');
    });

    it('reports on V8 after the ratios across processes, from a traced run without --processes', async () => {
        const { status, stdout, stderr, d8Runs } = await runFake('measures', [
            D8_BUNDLE,
            '--',
            '--processes',
            '2',
            '--v8-report'
        ]);
        const traced = d8Runs.at(-1) ?? [];
        const ratios = stdout.indexOf('\npair: 2 processes, by the fastest round\n');

        expect(status, stderr).toBe(0);
        expect(d8Runs).toHaveLength(3);
        expect(traced).toContain('--log-code');
        expect(parseOptions(traced.slice(traced.indexOf(D8_BUNDLE) + 2))).toMatchObject({
            processes: 1,
            json: undefined
        });
        expect(ratios).toBeGreaterThan(-1);
        expect(ratios).toBeLessThan(stdout.indexOf('V8 report of '));
    });

    it("exits with d8's code if the first run fails, and throws if a later one does", async () => {
        const first = await runFake('fails', [D8_BUNDLE, '--', '--processes', '3']);
        const later = await runFake('measures-then-fails', [D8_BUNDLE, '--', '--processes', '3']);

        expect(first.status).toBe(1);
        expect(first.d8Runs).toHaveLength(1);
        expect(first.stdout).toContain('Error: boom');
        expect(later.status).toBe(1);
        expect(later.d8Runs).toHaveLength(2);
        // A later run's stdout doesn't show
        expect(later.stdout).not.toContain('Error: boom');
        expect(later.stderr.trimEnd()).toBe(
            `benk-d8: Error: Expected run 2 of 3 of ${D8_BUNDLE} in d8 to exit with 0, got 1`
        );
    });
});

/** d8's version, or undefined where d8 isn't installed */
function d8Version(): string | undefined {
    const shell = spawnSync('d8', ['-e', 'print(version())'], { encoding: 'utf8' });

    return shell.error ? undefined : shell.stdout.trim();
}

const version = d8Version();

/** The flags of d8 that `D8Runtime`'s count of array buffers needs */
const BUFFER_FLAGS = ['--allow-natives-syntax', '--expose-gc', '--expose-statistics'];

/** A script that fills a `Float64Array` of 1,000 numbers in each call */
const BUFFERS_SCRIPT = `import { bench } from 'benk/d8';

function fillNumbers() {
    return new Float64Array(1000).fill(1);
}

await bench([{ name: 'buffers', variants: [{ name: 'fill', run: fillNumbers }] }]);
`;

/**
 * Writes `BUFFERS_SCRIPT` to the directory, bundled with `benk/d8` as this
 * process resolves it, from its source or from its bundle, as d8 runs a
 * script of one module, and returns the bundle's path
 */
async function writeBuffersScript(directory: string): Promise<string> {
    const source = join(directory, 'buffers-source.mjs');
    const script = join(directory, 'buffers.mjs');
    await writeFile(source, BUFFERS_SCRIPT);

    await build({
        input: source,
        output: { file: script },
        platform: 'neutral',
        resolve: {
            alias: { 'benk/d8': fileURLToPath(import.meta.resolve('benk/d8')) }
        },
        logLevel: 'silent'
    });

    return script;
}

describe.runIf(version)('benk-d8 in d8', () => {
    const QUICK = ['--rounds', '6', '--warmup-rounds', '1'];

    it("runs the script in d8, and then reports V8's work in its sources", async () => {
        const { status, stdout, stderr } = await runCommand([
            D8_BUNDLE,
            '--',
            ...QUICK,
            '--v8-filter',
            '^sum$'
        ]);
        const report = reportOf(stdout);

        expect(status, stderr).toBe(0);
        expect(stdout.split('\n')[0]).toMatch(new RegExp(`^d8 ${version}, `));
        expect(stdout).toContain('\nsums: ');
        expect(report.slice(0, 3)).toStrictEqual([
            `V8 report of ${D8_BUNDLE}, from a run of it in d8 ${version} with V8's traces, whose times aren't reported.`,
            "Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.",
            'Only the functions whose names match ^sum$.'
        ]);
        expect(report[3]).toMatch(new RegExp(`^sum ${BENCH}:19:13, \\d+ B of bytecode$`));
    });

    it('writes the results of the first run as JSON to stdout, and the tables and report to stderr', async () => {
        const { status, stdout, stderr } = await runCommand([
            D8_BUNDLE,
            '--',
            ...QUICK,
            '--json',
            '-',
            '--v8-report'
        ]);
        const result = JSON.parse(stdout) as { runtime: { name: string } };

        expect(status, stderr).toBe(0);
        expect(result.runtime.name).toBe('d8');
        expect(stderr).toContain('\nsums: ');
        expect(reportOf(stderr)[0]).toMatch(/^V8 report of /);
    });

    it("runs the script in d8 in each process, and prints each variant's ratio in each", async () => {
        const { status, stdout, stderr } = await runCommand([
            D8_BUNDLE,
            '--',
            ...QUICK,
            '--processes',
            '2',
            '--json',
            '-'
        ]);
        const result = JSON.parse(stdout) as RunResult;

        expect(status, stderr).toBe(0);
        expect(result.runtime.name).toBe('d8');
        expect(result.processes?.runs).toHaveLength(1);
        expect(result.processes?.groups.map(group => group.name)).toStrictEqual(['sums']);
        expect(stderr).toMatch(/\nsums: 2 processes, by the (fastest|median) round\n/);
    });

    it('counts array buffers with the flags of d8 that the count needs, and reports with them', async () => {
        await inDirectory(async directory => {
            const script = await writeBuffersScript(directory);

            const { status, stdout, stderr } = await runCommand([
                ...BUFFER_FLAGS,
                script,
                '--',
                ...QUICK,
                '--json',
                '-',
                '--v8-filter',
                '^fillNumbers$'
            ]);
            const result = JSON.parse(stdout) as RunResult;
            const report = reportOf(stderr);

            expect(status, stderr).toBe(0);
            expect(result.runtime.flags).toStrictEqual([...BUFFER_FLAGS, 'unknown']);
            expect(
                result.groups[0].variants.map(({ arrayBufferBytes }) => arrayBufferBytes)
            ).toStrictEqual([8000, 8000]);
            expect(report[2]).toBe('Only the functions whose names match ^fillNumbers$.');
            expect(report[3]).toMatch(/^fillNumbers \S+buffers\.mjs:\d+:\d+, \d+ B of bytecode$/);
        });
    });

    it("exits with d8's code, and traces nothing, when the script throws in d8", async () => {
        await inDirectory(async directory => {
            const script = join(directory, 'throws.mjs');
            await writeFile(script, "throw new Error('Thrown in d8');\n");

            const { status, stdout } = await runCommand([script, '--', '--v8-report']);

            expect(status).toBe(1);
            expect(stdout).toContain('Error: Thrown in d8');
            expect(stdout).not.toContain('V8 report');
        });
    });
});
