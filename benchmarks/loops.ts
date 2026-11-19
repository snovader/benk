// What the awaiting timer loop of async variants costs per call, against the
// sync loop: the same work, called from each loop. Run it with
// `node benchmarks/loops.ts`.
import { main, type Variant } from 'benk';

/** A step of a linear congruential generator: a few nanoseconds of work */
let state = 1;
function step(): number {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
}

/** About a microsecond of work */
function steps(): number {
    let value = 0;
    for (let i = 0; i < 400; i++) {
        value ^= step();
    }

    return value;
}

/**
 * The same work as a sync variant, as an async function's, and as a resolved
 * promise's
 */
function loops(work: () => number): Variant[] {
    return [
        { name: 'sync loop', run: () => work() },
        {
            name: 'async function',
            async: true,
            // oxlint-disable-next-line typescript/require-await -- An async function's own cost is what's measured
            run: async () => work()
        },
        {
            name: 'resolved promise',
            async: true,
            run: () => Promise.resolve(work())
        }
    ];
}

await main([
    { name: 'a step of a few ns', variants: loops(step) },
    { name: '400 steps', variants: loops(steps) }
]);
