import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'hypotes';
import { bench, parseOptions, type Group } from 'benk';
import { FakeRuntime } from './fake-runtime.ts';

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
            json: undefined
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
            '--no-heap'
        ]);

        expect(options).toStrictEqual({
            rounds: 51,
            warmupRounds: 0,
            sampleTime: 2.5,
            aa: false,
            heap: false,
            filter: /^record/u,
            json: 'results.json'
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
        const parse = (): unknown => parseOptions(['--filter', '[']);

        expect(parse).toThrow(SyntaxError);
        expect(parse).toThrow(/--filter.*\[/);
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
});
