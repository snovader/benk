import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'hypotes';
import { bench, parseOptions, type Group } from 'benk';
import { FakeRuntime } from './fake-runtime.ts';
import { BENCH, BUNDLE, BUNDLED, REPOSITORY } from './v8-fixtures.ts';

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
            v8Filter: undefined
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
            '^sum'
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
            v8Filter: /^sum/u
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

    it('measures in the traced run of another process, without printing, writing JSON, or running again', async () => {
        const runtime = new FakeRuntime();
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        const lines: string[] = [];
        vi.stubEnv('BENK_TRACED_RUN', '1');
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
async function runScript(script: string, args: readonly string[]): Promise<string[]> {
    // Run as the package's scripts run the tests, whose flags the traced run has too
    const { stdout } = await promisify(execFile)(
        process.execPath,
        [
            '--no-strip-types',
            '--import',
            '@snovader/node-hooks/register',
            script,
            ...args,
            '--rounds',
            '6',
            '--warmup-rounds',
            '1'
        ],
        { cwd: REPOSITORY }
    );

    return stdout.split(/\r?\n/);
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
        // Each function's name and position, before the size of its
        // bytecode, which differs between versions of V8
        const functions = lines
            .slice(heading + 3)
            .filter(line => !line.startsWith('  ') && line !== '')
            .map(line => line.slice(0, line.indexOf(',')));

        expect(lines[heading + 2]).toBe('Only the functions whose names match ^sum$.');
        expect(functions).toStrictEqual([`sum ${join(BUNDLED, 'sum.ts')}:6:20`]);
    });
});
