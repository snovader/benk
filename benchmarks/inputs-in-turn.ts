// What a constant input does to a call's time, against inputs in turn, and
// what `inTurn()` adds to a call, against a counter written by hand. Run it
// with `node --no-strip-types --import @snovader/node-hooks/register
// benchmarks/inputs-in-turn.ts`, and `--sample-ms 10` for rounds in which
// Turbofan compiles the timer loops.
import { bench, inTurn, type Variant } from 'benk';

/** The numbers of each array that a call sums */
const SIZE = 1000;

/** The arrays that the calls take in turn */
const TURNS = 4;

function floats(size: number): Float64Array[] {
    return Array.from({ length: TURNS }, (_unused, turn) =>
        Float64Array.from({ length: size }, (_value, i) => Math.sin(i + turn))
    );
}

function sum(values: Float64Array): number {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        total += values[i];
    }

    return total;
}

/**
 * A read that V8 can do once for a whole loop of calls, where the array is
 * a constant
 */
function first(values: Float64Array): number {
    return values[0];
}

/**
 * A step of a linear congruential generator, which V8 can't do ahead of its
 * call, whatever the array: a few nanoseconds of work, which shows what taking a
 * turn adds to a call
 */
let state = 1;
function step(values: Float64Array): number {
    state = (Math.imul(state, 1_103_515_245) + values.length) | 0;

    return state;
}

/**
 * The same call with one array every time, with the arrays in turn by a
 * counter that the variant keeps itself, and with `inTurn()`'s
 */
function variants(
    work: (values: Float64Array) => number,
    arrays: Float64Array[]
): Variant[] {
    const [constant] = arrays;

    let turn = 0;
    const byHand = (): Float64Array => {
        const current = turn;
        turn = current + 1 === arrays.length ? 0 : current + 1;

        return arrays[current];
    };

    const next = inTurn(arrays);

    return [
        { name: 'one input', run: () => work(constant) },
        { name: 'in turn, by hand', run: () => work(byHand()) },
        { name: 'in turn, inTurn()', run: () => work(next()) }
    ];
}

await bench([
    {
        name: `sum ${SIZE.toLocaleString('en-US')} numbers`,
        variants: variants(sum, floats(SIZE))
    },
    { name: 'read a number', variants: variants(first, floats(SIZE)) },
    { name: 'a step of a generator', variants: variants(step, floats(SIZE)) }
]);
