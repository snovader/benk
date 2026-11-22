// The groups of the benchmark of what benk counts of calls that allocate,
// which `node.ts` runs in Node and `d8.ts` in d8, the V8 shell: calls that
// allocate nothing, a small object, a number on the heap, a typed array
// small enough for V8 to keep its contents on the heap, and typed arrays
// whose contents it keeps outside. Each call is a group of its own, so that
// each group's lead is chosen from that call alone.
import type { Group } from 'benk/core';

let next = 0;

/**
 * An array that holds a string, so that V8 keeps its elements as pointers,
 * and stores a fractional number in it as a number on the heap
 */
const boxes: unknown[] = [''];

/** A group of one call, with the A/A copy that benk adds */
function alone(name: string, run: () => unknown): Group {
    return { name, variants: [{ name, run }] };
}

export const groups: Group[] = [
    alone('nothing', () => next),
    alone('a small object', () => ({ value: next++ })),
    alone('a heap number', () => (boxes[0] = next++ + 0.5)),
    alone('Uint8Array of 64 B', () => new Uint8Array(64)),
    alone('Float64Array of 1 KiB', () => new Float64Array(128)),
    alone('Float64Array of 64 KiB', () => new Float64Array(8192)),
    alone('Float64Array of 1 MiB', () => new Float64Array(131_072))
];
