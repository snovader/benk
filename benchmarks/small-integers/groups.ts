// The groups of the benchmark of small integers' width, which `node.ts` runs
// in Node and `d8.ts` in d8, the V8 shell. V8 keeps an integer in place of a
// pointer, as a small integer, when it fits: in 32 bits in Node, and in 31
// where V8 compresses pointers, as in d8, workerd and Chrome. There, an
// integer from 2³⁰ to 2³¹ − 1 is a number on the heap. Each group does the
// same work on integers just below 2³⁰, and on as many from 2³⁰, in a shape
// that holds them:
//
// - object fields: new objects, whose field holds a small integer, or with
//   31 bits from 2³⁰, a heap number for each object;
// - number[]: an array that holds small integers, or with 31 bits from 2³⁰,
//   doubles;
// - Int32Array: 32-bit integers either way, a control.
//
// Compare the ratios within each engine: Node's V8 and d8's are different
// versions, so a time in one against the other compares them too.
import type { Group } from 'benk/core';

/** The integers of a call */
const COUNT = 1000;

/** The span of each range of integers: 20 bits */
const SPAN = 2 ** 20;

/** The first integer of each range: just below 2³⁰, and 2³⁰ */
const BELOW = 2 ** 30 - SPAN;
const FROM = 2 ** 30;

/**
 * The inputs of each range, which the calls take in turn, so that V8 can't
 * compile a call for one constant array, as the README's constant inputs
 * describe
 */
const INPUTS = 4;

/**
 * Arrays of integers from `start`, each a different sequence. Each range gets
 * the same offsets from its start, from the same generator.
 */
function inputs(start: number): Int32Array[] {
    let state = 1;

    return Array.from({ length: INPUTS }, () => {
        const values = new Int32Array(COUNT);
        for (let i = 0; i < COUNT; i++) {
            state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
            values[i] = start + (state >>> 12);
        }

        return values;
    });
}

/**
 * Returns a range's inputs in turn. Its closures share their feedback, which
 * is the same for both: an array of `Int32Array`s, and a small count.
 */
function inTurn(start: number): () => Int32Array {
    const arrays = inputs(start);
    let next = 0;

    return () => arrays[next++ % INPUTS];
}

const belowInputs = inTurn(BELOW);
const fromInputs = inTurn(FROM);

// Each variant calls a function of its own, rather than a closure of a
// shared one, so that V8 keeps the feedback of each range apart: a function's
// closures share theirs. The objects of each range have a property of their
// own name too, since objects of the same properties share a map, whose
// field's representation would then hold either range.

const belowObjects: Array<{ below: number }> = [];
function objectsBelow(values: Int32Array): number {
    for (let i = 0; i < COUNT; i++) {
        belowObjects[i] = { below: values[i] };
    }

    let result = 0;
    for (let i = 0; i < COUNT; i++) {
        result ^= belowObjects[i].below;
    }

    return result;
}

const fromObjects: Array<{ from: number }> = [];
function objectsFrom(values: Int32Array): number {
    for (let i = 0; i < COUNT; i++) {
        fromObjects[i] = { from: values[i] };
    }

    let result = 0;
    for (let i = 0; i < COUNT; i++) {
        result ^= fromObjects[i].from;
    }

    return result;
}

const belowNumbers: number[] = [];
function numbersBelow(values: Int32Array): number {
    for (let i = 0; i < COUNT; i++) {
        belowNumbers[i] = values[i];
    }

    let result = 0;
    for (let i = 0; i < COUNT; i++) {
        result ^= belowNumbers[i];
    }

    return result;
}

const fromNumbers: number[] = [];
function numbersFrom(values: Int32Array): number {
    for (let i = 0; i < COUNT; i++) {
        fromNumbers[i] = values[i];
    }

    let result = 0;
    for (let i = 0; i < COUNT; i++) {
        result ^= fromNumbers[i];
    }

    return result;
}

const belowInt32 = new Int32Array(COUNT);
function int32Below(values: Int32Array): number {
    for (let i = 0; i < COUNT; i++) {
        belowInt32[i] = values[i];
    }

    let result = 0;
    for (let i = 0; i < COUNT; i++) {
        result ^= belowInt32[i];
    }

    return result;
}

const fromInt32 = new Int32Array(COUNT);
function int32From(values: Int32Array): number {
    for (let i = 0; i < COUNT; i++) {
        fromInt32[i] = values[i];
    }

    let result = 0;
    for (let i = 0; i < COUNT; i++) {
        result ^= fromInt32[i];
    }

    return result;
}

// Each group leads with the median round, in both engines: d8's runtime
// counts no heap bytes, from which a group would otherwise choose its lead
export const groups: Group[] = [
    {
        name: 'object fields',
        lead: 'median',
        variants: [
            { name: 'below 2³⁰', run: () => objectsBelow(belowInputs()) },
            { name: 'from 2³⁰', run: () => objectsFrom(fromInputs()) }
        ]
    },
    {
        name: 'number[]',
        lead: 'median',
        variants: [
            { name: 'below 2³⁰', run: () => numbersBelow(belowInputs()) },
            { name: 'from 2³⁰', run: () => numbersFrom(fromInputs()) }
        ]
    },
    {
        name: 'Int32Array',
        lead: 'median',
        variants: [
            { name: 'below 2³⁰', run: () => int32Below(belowInputs()) },
            { name: 'from 2³⁰', run: () => int32From(fromInputs()) }
        ]
    }
];
