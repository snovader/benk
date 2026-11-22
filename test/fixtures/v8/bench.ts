// The benchmark whose traced runs are this directory's fixtures, which
// `capture.ts` writes. Its variants reach Maglev and Turbofan, inline and
// don't, and deoptimize, so that the traces have each kind of line that the
// parsers read.
import { bench } from 'benk';

const SIZE = 1000;

const integers = Array.from({ length: SIZE }, (_, i) => i);
const doubles = Array.from({ length: SIZE }, (_, i) => i + 0.5);

// A loop at the top level, which V8 compiles as it runs, by on-stack
// replacement
let checksum = 0;
for (let i = 0; i < 1_000_000; i++) {
    checksum = (checksum + i * i) % 1_000_003;
}

function sum(values: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        total += values[i];
    }

    return total;
}

/** Too large for Turbofan to inline, at more than 460 B of bytecode */
function mix(seed: number): number {
    let h = seed | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    h = Math.imul(h ^ (h >>> 11), 0x1b873593);
    h ^= h >>> 14;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 17), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    h = Math.imul(h ^ (h >>> 11), 0x1b873593);
    h ^= h >>> 14;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 17), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;

    return h >>> 0;
}

/** Calls `mix` in a loop, which Turbofan compiles, but can't inline it into */
function mixAll(values: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < values.length; i += 10) {
        total += mix(values[i]);
    }

    return total;
}

const statistics = {
    // A name with a comma and a letter beyond ASCII, which the log escapes
    'mean, μ': (values: readonly number[]) => sum(values) / values.length
};

let calls = checksum % 2;

await bench([
    {
        name: 'sums',
        variants: [
            { name: 'integers', run: () => sum(integers) },
            { name: 'mean', run: () => statistics['mean, μ'](integers) },
            {
                // Integers, and then doubles, for which the code that V8
                // compiled for integers deoptimizes
                name: 'switching',
                run: () => sum(++calls < 20_000 ? integers : doubles)
            },
            { name: 'mixed', run: () => mixAll(integers) }
        ]
    }
]);
