import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main, parseOptions, type Group } from 'benk';
import { FakeRuntime } from './fakeRuntime.ts';

const QUICK = ['--sample-ms', '0.01', '--warmup-rounds', '1', '--rounds', '6'];

describe('parseOptions', () => {
    it('defaults to 31 rounds of 1 ms after 10 warm-up rounds, with an A/A pair and heap bytes', () => {
        assert.deepEqual(parseOptions([]), {
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

        assert.deepEqual(options, {
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
        assert.throws(() => parseOptions(['--round', '3']), TypeError);
        assert.throws(() => parseOptions(['--rounds']), TypeError);
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
            assert.throws(() => parseOptions(args), RangeError, args.join(' '));
        }
    });
});

describe('main', () => {
    function groups(runtime: FakeRuntime): Group[] {
        return [
            { name: 'first', variants: [runtime.variant('a', 50), runtime.variant('b', 100)] },
            { name: 'second', variants: [runtime.variant('c', 10)] }
        ];
    }

    it('prints a description of the run and the table of each group that the filter selects', async () => {
        const runtime = new FakeRuntime();
        const lines: string[] = [];

        const result = await main(groups(runtime), {
            args: [...QUICK, '--filter', 'first'],
            runtime,
            print: line => lines.push(line)
        });

        assert.match(lines[0], /^Fake 1\.0\.0, none, test none, none\./u);
        assert.ok(
            lines.includes(
                'first: 6 rounds, by the fastest round (every call under 1 µs and 1 KiB)'
            )
        );
        assert.deepEqual(
            lines
                .filter(line => line.startsWith('  ') && line.trim() !== '')
                .map(line => line.trim().split(/\s{2,}/u)[0]),
            ['fastest', 'a', 'b', 'a A/A']
        );
        assert.ok(!lines.some(line => line.startsWith('second')));
        assert.deepEqual(
            result.groups.map(group => group.name),
            ['first']
        );
    });

    it('writes the results as JSON to a file', async () => {
        const runtime = new FakeRuntime();
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        try {
            const path = join(directory, 'results.json');
            const result = await main(groups(runtime), {
                args: [...QUICK, '--json', path],
                runtime,
                print: () => undefined
            });

            assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    it('writes the results as JSON to stdout for -, apart from the tables', async () => {
        const runtime = new FakeRuntime();
        const written: string[] = [];
        const printed: string[] = [];

        const result = await main(groups(runtime), {
            args: [...QUICK, '--json', '-'],
            runtime,
            print: line => printed.push(line),
            write: text => written.push(text)
        });

        assert.equal(written.length, 1);
        assert.deepEqual(JSON.parse(written[0]), result);
        assert.ok(printed.some(line => line.startsWith('second: ')));
    });
});
