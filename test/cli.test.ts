import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'hypotes';
import { bench, parseOptions, type Group, type RunResult } from 'benk';
import { FakeRuntime } from './fake-runtime.ts';
import { BENCH, BUNDLE, BUNDLED, REPOSITORY } from './v8-fixtures.ts';

/**
 * A benchmark with a function over Turbofan's limit, which Turbofan
 * considers inlining in every run, as it runs with `--allow-natives-syntax`
 */
const OVER_BUDGET = join('test', 'fixtures', 'v8', 'over-budget.mjs');

const QUICK = ['--sample-ms', '0.01', '--warmup-rounds', '1', '--rounds', '6'];

describe('parseOptions', () => {
    it('defaults to 31 rounds of 1 ms after 10 warm-up rounds, with an A/A pair and heap bytes', () => {
        expect(parseOptions([])).toStrictEqual({
            rounds: 31,
            warmupRounds: 10,
            sampleTime: 1,
            aa: true,
            heap: true,
            filter: undefined,
            json: undefined,
            v8Report: false,
            v8Filter: undefined,
            v8Check: false,
            v8MaxBytecode: undefined
        });
    });

    it('reads every option', () => {
        const options = parseOptions([
            '--rounds=51',
            '--warmup-rounds',
            '0',
            '--sample-ms',
            '2.5',
            '--filter',
            '^record',
            '--json',
            'results.json',
            '--no-aa',
            '--no-heap',
            '--v8-report',
            '--v8-filter',
            '^sum',
            '--v8-check',
            '--v8-max-bytecode',
            '400'
        ]);

        expect(options).toStrictEqual({
            rounds: 51,
            warmupRounds: 0,
            sampleTime: 2.5,
            aa: false,
            heap: false,
            filter: /^record/u,
            json: 'results.json',
            v8Report: true,
            v8Filter: /^sum/u,
            v8Check: true,
            v8MaxBytecode: 400
        });
    });

    it('reports on V8 for a filter of its functions, without --v8-report', () => {
        expect(parseOptions(['--v8-filter', 'sum'])).toMatchObject({
            v8Report: true,
            v8Filter: /sum/u
        });
    });

    it('rejects an unknown option, or one without its value', () => {
        expect(() => parseOptions(['--round', '3'])).toThrow(TypeError);
        expect(() => parseOptions(['--rounds'])).toThrow(TypeError);
    });

    it('rejects numbers out of their range', () => {
        for (const args of [
            ['--rounds', '0'],
            ['--rounds', '1.5'],
            ['--rounds', 'many'],
            ['--rounds', ''],
            ['--warmup-rounds=-1'],
            ['--warmup-rounds', ''],
            ['--sample-ms', '0'],
            ['--sample-ms', 'Infinity'],
            ['--sample-ms', 'soon']
        ]) {
            expect(() => parseOptions(args), args.join(' ')).toThrow(RangeError);
        }
    });

    it('rejects a filter that is not a regular expression, and names the option', () => {
        for (const option of ['--filter', '--v8-filter']) {
            const parse = (): unknown => parseOptions([option, '[']);

            expect(parse).toThrow(SyntaxError);
            expect(parse).toThrow(new RegExp(`^Expected ${option} .*\\[`));
        }
    });
});

describe('bench', () => {
    const groups = (runtime: FakeRuntime): Group[] => [
        { name: 'first', variants: [runtime.variant('a', 50), runtime.variant('b', 100)] },
        { name: 'second', variants: [runtime.variant('c', 10)] }
    ];

    it('prints a description of the run and the table of each group that the filter selects', async () => {
        const runtime = new FakeRuntime();
        const lines: string[] = [];

        const result = await bench(groups(runtime), {
            args: [...QUICK, '--filter', 'first'],
            runtime,
            print: line => lines.push(line)
        });

        const rows = lines
            .filter(line => line.startsWith('  ') && line.trim() !== '')
            .map(line => line.trim().split(/\s{2,}/)[0]);

        expect(lines[0]).toMatch(/^Fake 1\.0\.0, none, test none, none\./);
        expect(lines).toContain(
            'first: 6 rounds, by the fastest round (every call under 1 µs and 1 KiB)'
        );
        expect(rows).toStrictEqual(['fastest', 'a', 'b', 'a A/A']);
        expect(lines.some(line => line.startsWith('second'))).toBe(false);
        expect(result.groups.map(group => group.name)).toStrictEqual(['first']);
    });

    it('writes the results as JSON to a file', async () => {
        const runtime = new FakeRuntime();
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        try {
            const path = join(directory, 'results.json');
            const result = await bench(groups(runtime), {
                args: [...QUICK, '--json', path],
                runtime,
                print: () => undefined
            });

            expect(JSON.parse(await readFile(path, 'utf8'))).toStrictEqual(result);
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    it('rejects a JSON file in a directory that it cannot write to, before it measures', async () => {
        const runtime = new FakeRuntime();
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        let calls = 0;
        try {
            const path = join(directory, 'missing', 'results.json');
            const counted = { name: 'counted', run: () => calls++ };

            const run = bench([{ name: 'group', variants: [counted] }], {
                args: [...QUICK, '--json', path],
                runtime,
                print: () => undefined
            });

            await expect(run).rejects.toThrow(/directory of --json/);
            expect(calls).toBe(0);
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    it('writes the results as JSON to stdout for -, apart from the tables', async () => {
        const runtime = new FakeRuntime();
        const written: string[] = [];
        const printed: string[] = [];

        const result = await bench(groups(runtime), {
            args: [...QUICK, '--json', '-'],
            runtime,
            print: line => printed.push(line),
            write: text => written.push(text)
        });

        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0])).toStrictEqual(result);
        expect(printed.some(line => line.startsWith('second: '))).toBe(true);
    });

    it('calls `after` last, with the print that printed the tables, and the results', async () => {
        const runtime = new FakeRuntime();
        const lines: string[] = [];
        const written: string[] = [];
        let handed: RunResult | undefined;

        const result = await bench(groups(runtime), {
            args: [...QUICK, '--json', '-'],
            runtime,
            print: line => lines.push(line),
            write: text => written.push(text),
            after: async (print, results) => {
                await Promise.resolve();
                print(`after ${written.length} written`);
                handed = results;
            }
        });

        expect(lines[lines.length - 1]).toBe('after 1 written');
        expect(handed).toBe(result);
    });

    it("prints `after`'s lines where the tables go: to stdout, or to stderr for --json -", async () => {
        const toStdout = await runAfter([]);
        const toStderr = await runAfter(['--json', '-']);
        const result = JSON.parse(toStderr.stdout) as RunResult;

        expect(toStdout.stdout.trimEnd().split('\n').slice(-1)).toStrictEqual(['1 group measured']);
        expect(toStdout.stderr).toBe('');
        expect(result.groups.map(group => group.name)).toStrictEqual(['calls']);
        expect(toStderr.stderr.trimEnd().split('\n').slice(-1)).toStrictEqual(['1 group measured']);
    });

    it('rejects with what `after` throws, after it wrote the JSON', async () => {
        const runtime = new FakeRuntime();
        const written: string[] = [];

        const run = bench(groups(runtime), {
            args: [...QUICK, '--json', '-'],
            runtime,
            print: () => undefined,
            write: text => written.push(text),
            after: () => {
                throw new RangeError('Thrown after the tables');
            }
        });

        await expect(run).rejects.toThrow(new RangeError('Thrown after the tables'));
        expect(written).toHaveLength(1);
    });

    it('measures in the traced run of another process, without printing, writing JSON, calling `after`, or running again', async () => {
        const runtime = new FakeRuntime();
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        const lines: string[] = [];
        vi.stubEnv('BENK_TRACED_RUN', '1');
        try {
            const path = join(directory, 'results.json');
            const result = await bench(groups(runtime), {
                args: [...QUICK, '--json', path, '--v8-report'],
                runtime,
                print: line => lines.push(line),
                after: print => {
                    print('after the tables');
                }
            });

            expect(result.groups.map(group => group.name)).toStrictEqual(['first', 'second']);
            expect(lines).toStrictEqual([]);
            await expect(access(path)).rejects.toThrow(/ENOENT/);
        } finally {
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true });
        }
    });
});

/** The lines that a script prints, with the arguments, from the repository's directory */
async function runScript(script: string, args: readonly string[]): Promise<string[]> {
    const { code, lines } = await runScriptWithCode(script, args);
    expect(code, lines.join('\n')).toBe(0);

    return lines;
}

/**
 * The lines that a script prints, and the code that it exits with, run with
 * Node's flags, if any, before the script
 */
async function runScriptWithCode(
    script: string,
    args: readonly string[],
    flags: readonly string[] = []
): Promise<{ code: number; lines: string[] }> {
    // Run as the package's scripts run the tests, whose flags the traced run has too
    const run = promisify(execFile)(
        process.execPath,
        [
            '--no-strip-types',
            '--import',
            '@snovader/node-hooks/register',
            ...flags,
            script,
            ...args,
            '--rounds',
            '6',
            '--warmup-rounds',
            '1'
        ],
        { cwd: REPOSITORY }
    );

    try {
        const { stdout } = await run;
        return { code: 0, lines: stdout.split(/\r?\n/) };
    } catch (error) {
        // A child that exits with another code than 0 rejects with its code and output
        const { code, stdout } = error as { code: number; stdout: string };
        return { code, lines: stdout.split(/\r?\n/) };
    }
}

/** What `fixtures/after.ts` wrote, whose `after` prints a line, run with the arguments */
async function runAfter(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return promisify(execFile)(
        process.execPath,
        [
            '--no-strip-types',
            '--import',
            '@snovader/node-hooks/register',
            join('test', 'fixtures', 'after.ts'),
            ...args,
            ...QUICK
        ],
        { cwd: REPOSITORY }
    );
}

describe('--v8-report', () => {
    it("runs the script again with V8's traces, and reports its functions", async () => {
        const lines = await runScript(BENCH, ['--v8-report']);
        const heading = lines.indexOf(
            `V8 report of ${BENCH}, from a run of it with V8's traces, whose times aren't reported.`
        );

        // After the tables, and with the function that each variant calls
        expect(heading).not.toBe(-1);
        expect(lines.findIndex(line => line.startsWith('sums: '))).toBeLessThan(heading);
        expect(lines.slice(heading).some(line => line.startsWith(`sum ${BENCH}:15:13, `))).toBe(
            true
        );
    });

    it("reports a bundle's functions in its sources, and only those that --v8-filter selects", async () => {
        const lines = await runScript(BUNDLE, ['--v8-filter', '^sum$']);
        const heading = lines.indexOf(
            `V8 report of ${BUNDLE}, from a run of it with V8's traces, whose times aren't reported.`
        );

        expect(heading).not.toBe(-1);
        expect(lines[heading + 2]).toBe('Only the functions whose names match ^sum$.');
        expect(reportedFunctions(lines, heading)).toStrictEqual([
            `sum ${join(BUNDLED, 'sum.ts')}:6:20`
        ]);
    });

    it('reports a bundle in its sources, if the script deletes it after bench()', async () => {
        const script = join(BUNDLED, 'build-and-bench.ts');
        const lines = await runScript(script, ['--v8-filter', '^sum$']);
        const heading = lines.indexOf(
            `V8 report of ${script}, from a run of it with V8's traces, whose times aren't reported.`
        );

        // Without a note that the bundle's positions are its own
        expect(heading).not.toBe(-1);
        expect(reportedFunctions(lines, heading)).toStrictEqual([
            `sum ${join(BUNDLED, 'sum.ts')}:6:20`
        ]);
    });
});

describe('--v8-check', () => {
    it("fails the run with exit code 2 for a function over Turbofan's limit", async () => {
        // Whose caller V8 compiles with Turbofan before bench(), with the
        // natives syntax, as a run of a few rounds may not
        const { code, lines } = await runScriptWithCode(
            OVER_BUDGET,
            ['--v8-check'],
            ['--allow-natives-syntax']
        );
        const failed = lines.indexOf('V8 check failed:');

        expect(code).toBe(2);
        expect(failed).not.toBe(-1);
        // Turbofan may consider it for the timer loop and its run too, after it
        expect(lines[failed + 1]).toMatch(
            new RegExp(
                `^  mix ${escaped(OVER_BUDGET)}:11:13, 874 B of bytecode, over Turbofan's 460 B, and considered for inlining into addMix ${escaped(OVER_BUDGET)}:54:16(, |$)`
            )
        );
    });

    it('passes, and exits with 0, where no listed function fails', async () => {
        const { code, lines } = await runScriptWithCode(BENCH, [
            '--v8-check',
            '--v8-filter',
            '^nothing$'
        ]);

        // Windows buffers V8's traces, among which the timed rounds can't be placed
        expect(code).toBe(0);
        expect(lines).toContain(
            process.platform === 'win32'
                ? "V8 check passed: no hot function of the report is over Turbofan's limit."
                : "V8 check passed: no hot function of the report is over Turbofan's limit, and none deoptimized in the timed rounds."
        );
    });

    it('writes the report into the JSON, with what V8 did with each variant', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        try {
            const path = join(directory, 'results.json');
            await runScript(BENCH, ['--v8-report', '--json', path]);
            const result = JSON.parse(await readFile(path, 'utf8')) as RunResult;

            const runs = result.groups[0].variants.map(({ name, v8 }) => {
                const position = v8?.run?.position;
                return [name, position?.line, position?.column];
            });
            expect(result.schema).toBe(4);
            expect(result.v8Report?.check).toBeNull();
            expect(result.v8Report?.functions.map(fn => fn.name)).toContain('mix');
            expect(runs).toStrictEqual([
                ['integers', 80, 9],
                ['mean', 84, 9],
                ['switching', 90, 9],
                ['mixed', 94, 9],
                ['integers A/A', 80, 9]
            ]);
        } finally {
            await rm(directory, { recursive: true });
        }
    });
});

/** A path as a regular expression matches it, as a Windows path's backslashes */
function escaped(path: string): string {
    return path.replaceAll(/[\\.]/g, character => `\\${character}`);
}

/**
 * The lines of a report's functions with a filter after its heading, up to
 * the blank line before its variants, but for each function's lines of
 * detail: its name and position, before the size of its bytecode, which
 * differs between versions of V8, or a note
 */
function reportedFunctions(lines: readonly string[], heading: number): string[] {
    const functions = lines.slice(heading + 3);

    return functions
        .slice(0, functions.indexOf(''))
        .filter(line => !line.startsWith('  '))
        .map(line => line.split(',', 1)[0]);
}
