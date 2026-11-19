import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
        ratio: 1,
        interval: null,
        heapBytes: 0,
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
    variants: [
        variant('tafla', 'reference', steady, {}),
        variant('tafla-gen', 'variant', bimodal, {
            ratio: 1.39,
            interval: [1.37, 1.95],
            heapBytes: 24.4
        }),
        variant('tafla A/A', 'aa', steady, {
            ratio: 1.004,
            interval: [0.987, 1.012],
            heapBytes: -3
        }),
        variant(
            'protobuf',
            'variant',
            steady.map(t => t * 20),
            { ratio: 20, interval: [19.5, 20.5], heapBytes: null }
        )
    ]
};

describe('formatGroup', () => {
    it('prints a row for each variant, and a note for each with two modes', () => {
        assert.deepEqual(formatGroup(group), [
            '',
            'record: serialize: 6 rounds, by the fastest round (every call under 1 µs and 1 KiB)',
            '                      fastest     median   spread    ratio   95% interval        heap',
            '  tafla               61.2 ns    63.0 ns     2.1%    1.00×                        0 B',
            '  tafla-gen           85.0 ns    85.6 ns    41.0%    1.39×      1.37–1.95        24 B',
            '  tafla A/A           61.2 ns    63.0 ns     2.1%    1.00×      0.99–1.01         0 B',
            '  protobuf            1.22 µs    1.26 µs     2.1%    20.0×      19.5–20.5           –',
            '  tafla-gen: two modes, 4 rounds near 85.4 ns and 3 near 121 ns'
        ]);
    });

    it('keeps two digits of a ratio far below 1, and a gap before a cell wider than its column', () => {
        const fast = variant('fast', 'variant', steady, {
            ratio: 0.00042,
            interval: [0.00039, 0.00046]
        });
        const row = formatGroup({ ...group, variants: [group.variants[0], fast] }).at(-1);

        assert.match(row ?? '', /% 0\.00042× 0\.00039–0\.00046 +0 B$/u);
    });

    it('notes a ratio by the fastest round that lies more than 5% outside its interval', () => {
        const [reference] = group.variants;
        const near = variant('near', 'variant', steady, { ratio: 1, interval: [1.04, 1.2] });
        const below = variant('below', 'variant', steady, { ratio: 1, interval: [1.1, 1.2] });
        const above = variant('above', 'variant', steady, { ratio: 2.5, interval: [1.9, 2.1] });
        const variants = [reference, near, below, above];
        const rows = 3 + variants.length;

        assert.deepEqual(formatGroup({ ...group, variants }).slice(rows), [
            '  below: 1.00× by the fastest rounds, but 1.10–1.20× round by round',
            '  above: 2.50× by the fastest rounds, but 1.90–2.10× round by round'
        ]);
        assert.equal(formatGroup({ ...group, lead: 'median', variants }).length, rows);
    });

    it('names the median round when the group leads with it', () => {
        const [, title] = formatGroup({ ...group, lead: 'median', leadReason: 'allocating calls' });
        assert.equal(
            title,
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

        assert.equal(
            first,
            'Node v26.0.0, V8 14.6, linux x64, A CPU, with --max-inlined-bytecode-size-cumulative=3000. Process state: benk from TypeScript source.'
        );
        assert.match(
            second,
            /at least 31 interleaved rounds of 1 ms per variant after 10 warm-up rounds/u
        );
        assert.doesNotMatch(third, /heap/u);
    });
});

describe('formatting', () => {
    it('writes times to three significant digits in a unit that fits', () => {
        assert.deepEqual(
            [0.0042, 0.5, 61.23, 999.4, 1234, 12_345, 123_456, 12_345_678, 2e9].map(formatTime),
            [
                '0.0042 ns',
                '0.50 ns',
                '61.2 ns',
                '999 ns',
                '1.23 µs',
                '12.3 µs',
                '123 µs',
                '12.3 ms',
                '2.00 s'
            ]
        );
    });

    it('writes bytes as whole bytes from 0', () => {
        assert.deepEqual([0, 24.4, 1234.5, -3].map(formatBytes), ['0 B', '24 B', '1,235 B', '0 B']);
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

        assert.deepEqual(JSON.parse(json), value);
        assert.match(json, /"samples": \[1, 2\.5, -3e-7\]/u);
        assert.match(json, /"positions": \[0, 1\]/u);
        assert.match(json, /"names": \[\n {4}"a",/u);
        assert.ok(json.endsWith('}\n'));
    });
});
