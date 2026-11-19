// Node's own runtime, with its compiled timer loops and V8's heap statistics.
// Times vary, so these check only what doesn't.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { measureGroup, NodeRuntime } from 'benk';

const QUICK = { sampleTime: 0.2, warmupRounds: 2, rounds: 6 };

describe('NodeRuntime', () => {
    it('describes Node and V8', () => {
        const { description } = new NodeRuntime();

        assert.equal(description.name, 'Node');
        assert.equal(description.version, process.version);
        assert.equal(description.engine, `V8 ${process.versions.v8}`);
        assert.ok(description.flags.every(flag => typeof flag === 'string'));
        assert.deepEqual(description.conditions, ['detached ArrayBuffer']);
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
            assert.ok(summary.fastest > 0 && summary.fastest < 1e6, `${summary.fastest} ns`);
            assert.ok(repetitions > 1);
        }
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
        const [none, objects, arrays] = result.variants.map(variant => variant.heapBytes);

        assert.ok(none !== null && Math.abs(none) < 2, `${none} B`);
        // Three fields of a header and two of their own, of 4 or 8 bytes each,
        // as V8 compresses pointers or not
        assert.ok(
            [20, 40].some(size => objects !== null && Math.abs(objects - size) < 2),
            `${objects} B`
        );
        // The elements, of 4 or 8 bytes, and the array
        assert.ok(arrays !== null && arrays > 4000 && arrays < 8400, `${arrays} B`);
    });
});
