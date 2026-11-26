import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'hypotes';
import { bench, parseOptions, type Group, type RunResult } from 'benk';
import { expectClose, expectPresent } from './expectations.ts';
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
            processes: 1,
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
            '--processes',
            '5',
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
            processes: 5,
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
            ['--processes', '0'],
            ['--processes', '2.5'],
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

    it('measures in the traced run of another process, without printing, writing JSON, or running again', async () => {
        const runtime = new FakeRuntime();
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        const lines: string[] = [];
        // As the traced run's parent sets them
        vi.stubEnv('BENK_TRACED_RUN', '1');
        vi.stubEnv('BENK_PARENT_PID', String(process.ppid));
        try {
            const path = join(directory, 'results.json');
            const result = await bench(groups(runtime), {
                args: [...QUICK, '--json', path, '--v8-report'],
                runtime,
                print: line => lines.push(line)
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
async function runScript(
    script: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv = {}
): Promise<string[]> {
    const { code, lines, stderr } = await runScriptWithCode(script, args, [], env);
    expect(code, `${lines.join('\n')}\n${stderr}`).toBe(0);

    return lines;
}

/**
 * The lines that a script prints, what it writes to stderr, and the code
 * that it exits with, run with Node's flags, if any, before the script, and
 * with the variables of `env` in its environment
 */
async function runScriptWithCode(
    script: string,
    args: readonly string[],
    flags: readonly string[] = [],
    env: NodeJS.ProcessEnv = {}
): Promise<{ code: number; lines: string[]; stderr: string }> {
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
        { cwd: REPOSITORY, env: { ...process.env, ...env } }
    );

    try {
        const { stdout, stderr } = await run;
        return { code: 0, lines: stdout.split(/\r?\n/), stderr };
    } catch (error) {
        // A child that exits with another code than 0 rejects with its code and output
        const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
        return { code, lines: stdout.split(/\r?\n/), stderr };
    }
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

    it('runs a process that the traced run starts as any other, which writes its JSON', async () => {
        const { code, stderr, runs, spawned } = await runProcesses(['--v8-report'], {
            PROCESSES_FAULT: 'spawns'
        });

        expect(code, stderr).toBe(0);
        // A traced run for each call of bench(), and the run that the first starts
        expect(runs).toBe(4);
        expect((JSON.parse(spawned) as RunResult).groups.map(group => group.name)).toStrictEqual([
            'crossing'
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
            expect(result.schema).toBe(5);
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

/** The script of the tests of `--processes`, which the fake runtime times */
const PROCESSES = join('test', 'fixtures', 'processes.ts');

/**
 * Runs `PROCESSES` with the arguments, and a quick sample time, in a
 * directory of its own, where it counts its runs and writes its JSON to
 * `results.json`, and returns what it wrote, its runs, and its results, and
 * those of a run that a run started, as `spawns` does
 */
async function runProcesses(
    args: readonly string[],
    env: NodeJS.ProcessEnv = {}
): Promise<{
    code: number;
    lines: string[];
    stderr: string;
    runs: number;
    json: string;
    spawned: string;
}> {
    const directory = await mkdtemp(join(tmpdir(), 'benk-'));
    try {
        const counter = join(directory, 'runs');
        const path = join(directory, 'results.json');
        const run = await runScriptWithCode(
            PROCESSES,
            [...args.map(arg => (arg === 'results.json' ? path : arg)), '--sample-ms', '0.01'],
            [],
            { ...env, PROCESSES_RUNS: counter }
        );

        return {
            ...run,
            runs: (await readFile(counter, 'utf8')).split('\n').length - 1,
            json: await readFile(path, 'utf8').catch(() => ''),
            spawned: await readFile(join(directory, 'spawned.json'), 'utf8').catch(() => '')
        };
    } finally {
        await rm(directory, { recursive: true });
    }
}

/** The words of a table's row, which `heading` starts, by the variant's name */
function rowOf(lines: readonly string[], heading: string, name: string): string[] {
    const at = lines.indexOf(heading);
    expect(at, lines.join('\n')).not.toBe(-1);

    const row = lines.slice(at).find(line => line.startsWith(`  ${name} `));
    return expectPresent(row, `Expected a row of ${name} after ${heading}`).trim().split(/\s+/);
}

describe('--processes', () => {
    it("runs the script again in other processes, and prints each variant's ratio in each", async () => {
        const { code, lines, stderr, runs, json } = await runProcesses([
            '--processes',
            '3',
            '--json',
            'results.json'
        ]);
        const result = JSON.parse(json) as RunResult;
        const processes = expectPresent(result.processes);
        const [, grows] = processes.groups[0].variants;

        // Each call of bench() takes its results from the same runs
        expect(code, stderr).toBe(0);
        expect(runs).toBe(3);
        // Only the first process prints, and its tables come first
        expect(lines.filter(line => line.startsWith('run '))).toStrictEqual(['run 1']);
        expect(
            lines.indexOf('pairs: 8 rounds, by the fastest round (every call under 1 µs and 1 KiB)')
        ).toBeLessThan(lines.indexOf('pairs: 3 processes, by the fastest round'));
        expect(rowOf(lines, 'pairs: 3 processes, by the fastest round', 'slower')).toStrictEqual([
            'slower',
            '2.00×',
            '2.20×',
            '2.40×',
            '2.20×',
            '2.00–2.40'
        ]);
        expect(lines).toContain(
            "  slower: round by round, the intervals of processes 1 and 3 don't overlap, 2.00–2.00 and 2.40–2.40"
        );
        expect(lines).toContain('  grows: faster than base in 1 process, and slower in 1');
        // The JSON is of the last call, as without the option
        expect(result.schema).toBe(5);
        expect(result.groups.map(group => group.name)).toStrictEqual(['crossing']);
        const fastest = processes.runs.map(run => run.groups[0].variants[1].summary.fastest);
        expect(fastest).toHaveLength(2);
        expectClose(fastest[0], 50);
        expectClose(fastest[1], 75);
        for (const [i, ratio] of [0.5, 1, 1.5].entries()) {
            expectClose(grows.ratios[i], ratio);
        }
    });

    it('measures in each process the groups that --filter selects', async () => {
        const { code, lines, stderr } = await runProcesses([
            '--processes',
            '2',
            '--filter',
            '^cross'
        ]);

        expect(code, stderr).toBe(0);
        expect(lines).toContain('crossing: 2 processes, by the fastest round');
        expect(lines.some(line => line.startsWith('pairs'))).toBe(false);
    });

    it('writes the JSON to stdout for --json -, and the ratios across processes with the tables to stderr', async () => {
        const { code, lines, stderr } = await runProcesses(['--processes', '2', '--json', '-']);
        // The script prints its run's number first, and bench() writes JSON twice
        const [first, ...json] = lines;
        const results = json
            .join('\n')
            .trimEnd()
            .split(/\n(?=\{)/)
            .map(text => JSON.parse(text) as RunResult);

        expect(code, stderr).toBe(0);
        expect(first).toBe('run 1');
        expect(results.map(result => result.processes?.runs.length)).toStrictEqual([1, 1]);
        expect(stderr).toContain('\npairs: 2 processes, by the fastest round\n');
    });

    it('throws for a run in another process that fails, after it writes the JSON without the other processes', async () => {
        const { code, stderr, runs, json } = await runProcesses(
            ['--processes', '3', '--json', 'results.json'],
            { PROCESSES_FAULT: 'fails' }
        );

        expect(code).toBe(1);
        expect(runs).toBe(2);
        expect(stderr).toContain('Error: The second run fails');
        expect(stderr).toContain(
            `Error: Expected the run of ${join(REPOSITORY, PROCESSES)} in process 2 of 3 to exit with 0, got 1`
        );
        expect((JSON.parse(json) as RunResult).processes).toBeNull();
    });

    it('throws for a run in another process that measured other groups', async () => {
        const { code, stderr } = await runProcesses(['--processes', '2'], {
            PROCESSES_FAULT: 'renames'
        });

        expect(code).toBe(1);
        expect(stderr).toContain(
            'Error: Expected process 2 to measure the groups of the first, with the same variants, got "renamed" of "base", "slower", "faster", "base A/A" where the first has "pairs" of "base", "slower", "faster", "base A/A"'
        );
    });

    it('takes no results from a process that a run starts, which runs as any other', async () => {
        const { code, lines, stderr, runs, spawned } = await runProcesses(['--processes', '2'], {
            PROCESSES_FAULT: 'spawns'
        });

        expect(code, stderr).toBe(0);
        expect(runs).toBe(3);
        // The second run's, of 110 ns, rather than the third's, of 120 ns
        expect(rowOf(lines, 'pairs: 2 processes, by the fastest round', 'slower')).toStrictEqual([
            'slower',
            '2.00×',
            '2.20×',
            '2.00–2.20'
        ]);
        expect((JSON.parse(spawned) as RunResult).groups.map(group => group.name)).toStrictEqual([
            'crossing'
        ]);
    });

    it('reports on V8 after the ratios across processes, and records both', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        try {
            const path = join(directory, 'results.json');
            const lines = await runScript(BENCH, [
                '--processes',
                '2',
                '--v8-filter',
                '^sum$',
                '--json',
                path
            ]);
            const result = JSON.parse(await readFile(path, 'utf8')) as RunResult;
            const heading = lines.findIndex(line => line.startsWith('V8 report of '));

            expect(
                lines.findIndex(line => line.startsWith('sums: 2 processes, by the '))
            ).toBeLessThan(heading);
            expect(heading).toBeGreaterThan(-1);
            expect(result.processes?.groups.map(group => group.name)).toStrictEqual(['sums']);
            expect(result.v8Report?.functions.map(fn => fn.name)).toStrictEqual(['sum']);
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
