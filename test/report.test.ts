import { describe, expect, it } from 'hypotes';
import {
    describeRun,
    formatBytes,
    formatGroup,
    formatJson,
    formatTime,
    summarize,
    type GroupResult,
    type VariantResult
} from 'benk';

function variant(
    name: string,
    role: VariantResult['role'],
    samples: number[],
    fields: Partial<VariantResult>
): VariantResult {
    return {
        name,
        role,
        async: false,
        repetitions: 1000,
        samples,
        positions: samples.map((_, i) => i % 3),
        summary: summarize(samples),
        change: null,
        positionEffect: null,
        ratio: 1,
        interval: null,
        heapBytes: 0,
        arrayBufferBytes: 0,
        v8: null,
        ...fields
    };
}

const steady = [61.2, 61.5, 62, 63, 63.1, 63.3, 64];
const bimodal = [85, 85.2, 85.4, 85.6, 120, 120.5, 121];

const group: GroupResult = {
    name: 'record: serialize',
    lead: 'fastest',
    leadReason: 'short calls',
    rounds: 6,
    timerResolution: 41.7,
    variants: [
        variant('tafla', 'reference', steady, {}),
        variant('tafla-gen', 'variant', bimodal, {
            ratio: 1.39,
            interval: [1.37, 1.95],
            heapBytes: 24.4,
            arrayBufferBytes: 1_048_576
        }),
        variant('tafla A/A', 'aa', steady, {
            ratio: 1.004,
            interval: [0.987, 1.012],
            heapBytes: -3,
            arrayBufferBytes: -0.4
        }),
        variant(
            'protobuf',
            'variant',
            steady.map(t => t * 20),
            { ratio: 20, interval: [19.5, 20.5], heapBytes: null, arrayBufferBytes: null }
        )
    ]
};

describe('formatGroup', () => {
    it('prints a row for each variant, and a note for each with two modes', () => {
        expect(formatGroup(group)).toStrictEqual([
            '',
            'record: serialize: 6 rounds, by the fastest round (every call under 1 µs and 1 KiB)',
            '                      fastest     median   spread    ratio   95% interval        heap     buffers',
            '  tafla               61.2 ns    63.0 ns     2.1%    1.00×                        0 B         0 B',
            '  tafla-gen           85.0 ns    85.6 ns    41.0%    1.39×      1.37–1.95        24 B 1,048,576 B',
            '  tafla A/A           61.2 ns    63.0 ns     2.1%    1.00×      0.99–1.01         0 B         0 B',
            '  protobuf            1.22 µs    1.26 µs     2.1%    20.0×      19.5–20.5           –           –',
            '  tafla-gen: two modes, 4 rounds near 85.4 ns and 3 near 121 ns'
        ]);
    });

    it('notes where the rounds changed, in place of their two modes, with what to do', () => {
        const [reference] = group.variants;
        const changed = (
            name: string,
            before: [number, number],
            after: [number, number]
        ): VariantResult =>
            variant(name, 'variant', bimodal, {
                change: {
                    before: { median: before[0], rounds: before[1] },
                    after: { median: after[0], rounds: after[1] }
                }
            });
        const variants = [
            reference,
            changed('early', [1450, 4], [805, 32]),
            changed('late', [2070, 22], [757, 14]),
            changed('slower', [2530, 6], [8220, 26]),
            changed('slower late', [128, 28], [233, 4]),
            variant('modes', 'variant', bimodal, {})
        ];
        const rows = 3 + variants.length;

        expect(formatGroup({ ...group, lead: 'median', variants }).slice(rows)).toStrictEqual([
            '  early: the first 4 rounds ran near 1.45 µs, and the other 32 near 805 ns: try a longer warm-up and check whether the early slowdown repeats',
            '  late: the last 14 rounds ran near 757 ns, and the other 22 near 2.07 µs: try a longer warm-up and check whether the early slowdown repeats',
            "  slower: the first 6 rounds ran near 2.53 µs, and the other 26 near 8.22 µs: another run shows whether that repeats, and V8's report whether its code deoptimized",
            "  slower late: the last 4 rounds ran near 233 ns, and the other 28 near 128 ns: another run shows whether that repeats, and V8's report whether its code deoptimized",
            '  modes: two modes, 4 rounds near 85.4 ns and 3 near 121 ns'
        ]);
    });

    it('notes a position whose rounds took longer or shorter, by its ordinal', () => {
        const [reference] = group.variants;
        const variants = [0, 1, 2, 3, 10, 11, 12, 20, 21, 22].map(position =>
            variant(`at ${position}`, 'variant', steady, {
                positionEffect: { position, median: 200, others: 100 }
            })
        );
        const notes = formatGroup({ ...group, variants: [reference, ...variants] }).slice(
            4 + variants.length
        );

        expect(notes[0]).toBe(
            '  at 0: its rounds ran near 200 ns when 1st in a round, and near 100 ns otherwise'
        );
        expect(notes.map(note => note.split(' when ')[1].split(' in a round')[0])).toStrictEqual([
            '1st',
            '2nd',
            '3rd',
            '4th',
            '11th',
            '12th',
            '13th',
            '21st',
            '22nd',
            '23rd'
        ]);
    });

    it('notes two modes in results of schema 4, which have no change', () => {
        const { change: _, ...before } = group.variants[1];
        const lines = formatGroup({
            ...group,
            lead: 'median',
            variants: [before as VariantResult]
        });

        expect(lines.slice(4)).toStrictEqual([
            '  tafla-gen: two modes, 4 rounds near 85.4 ns and 3 near 121 ns'
        ]);
    });

    it('keeps two digits of a ratio far below 1, and a gap before a cell wider than its column', () => {
        const fast = variant('fast', 'variant', steady, {
            ratio: 0.00042,
            interval: [0.00039, 0.00046]
        });
        const lines = formatGroup({ ...group, variants: [group.variants[0], fast] });

        expect(lines[lines.length - 1]).toMatch(/% 0\.00042× 0\.00039–0\.00046 +0 B +0 B$/);
    });

    it('notes a ratio by the fastest round that lies more than 5% outside its interval', () => {
        const [reference] = group.variants;
        const near = variant('near', 'variant', steady, { ratio: 1, interval: [1.04, 1.2] });
        const below = variant('below', 'variant', steady, { ratio: 1, interval: [1.1, 1.2] });
        const above = variant('above', 'variant', steady, { ratio: 2.5, interval: [1.9, 2.1] });
        const variants = [reference, near, below, above];
        const rows = 3 + variants.length;

        expect(formatGroup({ ...group, variants }).slice(rows)).toStrictEqual([
            '  below: 1.00× by the fastest rounds, but 1.10–1.20× round by round',
            '  above: 2.50× by the fastest rounds, but 1.90–2.10× round by round'
        ]);
        expect(formatGroup({ ...group, lead: 'median', variants })).toHaveLength(rows);
    });

    it("notes median rounds of less than 50 times the timer's resolution", () => {
        const coarse = (median: number): GroupResult => ({
            ...group,
            timerResolution: 1e6,
            variants: [
                variant('reference', 'reference', [median, median, median], {}),
                variant('long calls', 'variant', [median * 100], { ratio: 100 })
            ]
        });
        const rows = 3 + 2;

        // 1,000 calls of 1 µs a round, a tick each
        expect(formatGroup(coarse(1000)).slice(rows)).toStrictEqual([
            "  median rounds are as short as 1 times the timer's resolution, of 1.00 ms: a sample time of 50.0 ms or more gives 50"
        ]);
        expect(formatGroup(coarse(49_400)).slice(rows)).toStrictEqual([
            "  median rounds are as short as 49 times the timer's resolution, of 1.00 ms: a sample time of 50.0 ms or more gives 50"
        ]);
        expect(formatGroup(coarse(50_000)).slice(rows)).toStrictEqual([]);
    });

    it('prints no bytes of array buffers for results of schema 2, which have none', () => {
        const { arrayBufferBytes: _, ...before } = group.variants[1];
        const lines = formatGroup({ ...group, variants: [before as VariantResult] });

        expect(lines[3]).toMatch(/ 24 B +–$/);
    });

    it('has no such note for results without a resolution', () => {
        const rows = formatGroup(group).length;

        expect(formatGroup({ ...group, timerResolution: null })).toHaveLength(rows);

        // As a file of results that a version before schema 2 wrote
        const { timerResolution: _, ...before } = group;
        expect(formatGroup(before as GroupResult)).toHaveLength(rows);
    });

    it('names the median round when the group leads with it', () => {
        const [, title] = formatGroup({ ...group, lead: 'median', leadReason: 'allocating calls' });
        expect(title).toBe(
            'record: serialize: 6 rounds, by the median round (a call allocating 1 KiB or more)'
        );
    });
});

describe('describeRun', () => {
    it('describes the runtime and what the rows report', () => {
        const runtime = {
            name: 'Node',
            version: 'v26.0.0',
            engine: 'V8 14.6',
            platform: 'linux',
            arch: 'x64',
            cpu: 'A CPU',
            flags: ['--max-inlined-bytecode-size-cumulative=3000'],
            processState: ['benk from TypeScript source']
        };
        const options = {
            rounds: 31,
            warmupRounds: 10,
            sampleTime: 1,
            aa: true,
            heap: false,
            filter: ''
        };
        const [first, second, third] = describeRun(runtime, options).split('\n');

        expect(first).toBe(
            'Node v26.0.0, V8 14.6, linux x64, A CPU, with --max-inlined-bytecode-size-cumulative=3000. Process state: benk from TypeScript source.'
        );
        expect(second).toMatch(
            /at least 31 interleaved rounds of 1 ms per variant after 10 warm-up rounds/
        );
        expect(third).not.toMatch(/heap/);
        expect(describeRun(runtime, { ...options, heap: true })).toMatch(
            /, and the bytes allocated on the heap and in array buffers outside it\.$/
        );
    });
});

describe('formatting', () => {
    it('writes times to three significant digits in a unit that fits', () => {
        const times = [0.0042, 0.5, 61.23, 999.4, 1234, 12_345, 123_456, 12_345_678, 2e9];

        expect(times.map(formatTime)).toStrictEqual([
            '0.0042 ns',
            '0.50 ns',
            '61.2 ns',
            '999 ns',
            '1.23 µs',
            '12.3 µs',
            '123 µs',
            '12.3 ms',
            '2.00 s'
        ]);
    });

    it('writes bytes as whole bytes from 0', () => {
        expect([0, 24.4, 1234.5, -3].map(formatBytes)).toStrictEqual([
            '0 B',
            '24 B',
            '1,235 B',
            '0 B'
        ]);
    });

    it('writes JSON with each array of numbers on one line', () => {
        const value = {
            samples: [1, 2.5, -3e-7],
            nested: { positions: [0, 1] },
            names: ['a', 'b'],
            // A string that holds what looks like an array of numbers
            name: 'at "[ 1, 2 ]"',
            empty: []
        };
        const json = formatJson(value);

        expect(JSON.parse(json)).toStrictEqual(value);
        expect(json).toMatch(/"samples": \[1, 2\.5, -3e-7\]/);
        expect(json).toMatch(/"positions": \[0, 1\]/);
        expect(json).toMatch(/"names": \[\n {4}"a",/);
        expect(json).toMatch(/\}\n$/);
    });

    it('writes an array of negative numbers and a null without backtracking', () => {
        // NaN is written as null, so the array isn't one of numbers. A pattern
        // that can match a number's minus in two ways tries each combination
        // of them before giving the array up, which takes seconds for 28.
        const value = [...new Array<number>(28).fill(-1), Number.NaN];

        const start = performance.now();
        const json = formatJson(value);
        const elapsed = performance.now() - start;

        expect(JSON.parse(json)).toStrictEqual([...new Array<number>(28).fill(-1), null]);
        expect(elapsed).toBeLessThan(1000);
    });
});
