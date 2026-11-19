// Node's own runtime, with its compiled timer loops and V8's heap statistics.
// Times vary, so these check only what doesn't.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bench, measureGroup, NodeRuntime } from 'benk';

const QUICK = { sampleTime: 0.2, warmupRounds: 2, rounds: 6 };

/** What the runtime records of benk's own loading: its source, or its bundle */
const BENK_LOADED = import.meta.resolve('benk').endsWith('.ts')
    ? ['benk from TypeScript source']
    : [];

const STRIPPING_OFF = "Node's type stripping off";

/**
 * What the runtime records of this process: benk's loading, this file, and
 * Node's type stripping, which `yarn test` turns off
 */
const LOADED = [
    ...BENK_LOADED,
    // Node's test runner runs this file as the entry script of a process
    'entry script from TypeScript source',
    ...(process.features.typescript === false ? [STRIPPING_OFF] : [])
];

/**
 * The process state of a new process that Node starts with `flags`, and
 * whose entry is a script on the command line rather than a file. It loads
 * benk as this one does, as it inherits `NODE_OPTIONS`.
 */
function processStateWith(flags: readonly string[]): unknown {
    const script =
        "import { NodeRuntime } from 'benk'; console.log(JSON.stringify(new NodeRuntime().description.processState));";
    const output = execFileSync(
        process.execPath,
        [...flags, '--input-type=module', '--eval', script],
        {
            // Inside benk's package, where the script can import it by its name
            cwd: join(import.meta.dirname, '..'),
            encoding: 'utf8'
        }
    );

    return JSON.parse(output);
}

describe('NodeRuntime', () => {
    it('describes Node and V8', () => {
        const { description } = new NodeRuntime();

        assert.equal(description.name, 'Node');
        assert.equal(description.version, process.version);
        assert.equal(description.engine, `V8 ${process.versions.v8}`);
        assert.ok(description.flags.every(flag => typeof flag === 'string'));
        assert.deepEqual(description.processState, LOADED);
    });

    it("records Node's type stripping off, where a hook strips the types", () => {
        const strippedByNode = processStateWith([]);
        const strippedByHook = processStateWith([
            '--no-strip-types',
            '--import',
            '@snovader/node-hooks/register'
        ]);

        assert.deepEqual(strippedByNode, BENK_LOADED);
        assert.deepEqual(strippedByHook, [...BENK_LOADED, STRIPPING_OFF]);
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

    it('prints what it knows of the process in the description of a run', async () => {
        const lines: string[] = [];
        const result = await bench([{ name: 'calls', variants: [{ name: 'a', run: () => 1 }] }], {
            args: ['--sample-ms', '0.2', '--warmup-rounds', '2', '--rounds', '2', '--no-heap'],
            runtime: new NodeRuntime(),
            print: line => lines.push(line)
        });
        const [first] = lines[0].split('\n');

        assert.deepEqual(result.runtime.processState, LOADED);
        assert.equal(
            first.endsWith(` Process state: ${LOADED.join(', ')}.`),
            LOADED.length > 0,
            first
        );
    });
});
