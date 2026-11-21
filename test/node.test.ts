// Node's own runtime, with its compiled timer loops and V8's heap statistics.
// Times vary, so these check only what doesn't.
import { describe, expect, it } from 'hypotes';
import { bench, measureGroup, NodeRuntime } from 'benk';
import { expectPresent } from './expectations.ts';

const QUICK = { sampleTime: 0.2, warmupRounds: 2, rounds: 6 };

/** What the runtime records of benk's own loading: its source, or its bundle */
const LOADED = [
    ...(import.meta.resolve('benk').endsWith('.ts') ? ['benk from TypeScript source'] : []),
    // Node's test runner runs this file as the entry script of a process
    'entry script from TypeScript source'
];

describe('NodeRuntime', () => {
    it('describes Node and V8', () => {
        const { description } = new NodeRuntime();

        expect(description.name).toBe('Node');
        expect(description.version).toBe(process.version);
        expect(description.engine).toBe(`V8 ${process.versions.v8}`);
        expect(description.flags.every(flag => typeof flag === 'string')).toBe(true);
        expect(description.processState).toStrictEqual(LOADED);
    });

    it('times sync and async calls', async () => {
        let count = 0;
        const result = await measureGroup(
            {
                name: 'calls',
                variants: [
                    { name: 'sync', run: () => (count = (count + 1) % 1024) },
                    { name: 'async', async: true, run: () => Promise.resolve(count) }
                ]
            },
            QUICK
        );

        for (const { summary, repetitions } of result.variants) {
            expect(summary.fastest).toBeGreaterThan(0);
            expect(summary.fastest).toBeLessThan(1e6);
            expect(repetitions).toBeGreaterThan(1);
        }
        // Node's clock is finer than a loop of an empty call, whose time it records
        const timerResolution = expectPresent(result.timerResolution);
        expect(timerResolution).toBeGreaterThan(0);
        expect(timerResolution).toBeLessThan(1e5);
    });

    it('counts the bytes that calls allocate on the heap', async () => {
        let count = 0;
        const result = await measureGroup(
            {
                name: 'heap',
                variants: [
                    { name: 'small integers', run: () => (count = (count + 1) % 1024) },
                    { name: 'objects', run: () => ({ a: count, b: count }) },
                    { name: 'arrays of 1,000', run: () => new Array<number>(1000).fill(count) }
                ]
            },
            // Rounds of more calls, over which a sample's error spreads
            { ...QUICK, sampleTime: 1 }
        );
        const [none, objects, arrays] = result.variants.map(variant =>
            expectPresent(variant.heapBytes, `no heap bytes of ${variant.name}`)
        );

        expect(Math.abs(none), `${none} B`).toBeLessThan(2);
        // Three fields of a header and two of their own, of 4 or 8 bytes each,
        // as V8 compresses pointers or not
        expect(
            [20, 40].some(size => Math.abs(objects - size) < 2),
            `${objects} B`
        ).toBe(true);
        // The elements, of 4 or 8 bytes, and the array
        expect(arrays).toBeGreaterThan(4000);
        expect(arrays).toBeLessThan(8400);
    });

    it('prints what it knows of the process in the description of a run', async () => {
        const lines: string[] = [];
        const result = await bench([{ name: 'calls', variants: [{ name: 'a', run: () => 1 }] }], {
            args: ['--sample-ms', '0.2', '--warmup-rounds', '2', '--rounds', '2', '--no-heap'],
            runtime: new NodeRuntime(),
            print: line => lines.push(line)
        });
        const [first] = lines[0].split('\n');

        expect(result.runtime.processState).toStrictEqual(LOADED);
        expect(first.endsWith(` Process state: ${LOADED.join(', ')}.`), first).toBe(
            LOADED.length > 0
        );
    });
});
