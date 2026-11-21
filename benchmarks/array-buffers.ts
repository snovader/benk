// What benk counts of calls that allocate typed arrays, whose contents V8
// keeps outside its heap, against calls that allocate nothing, a small
// object, and an array of 1 KiB on the heap. Each call is a group of its
// own, so that each group's lead is chosen from that call alone. Run it with
// `node --no-strip-types --import @snovader/node-hooks/register
// benchmarks/array-buffers.ts`.
import { bench, type Group } from 'benk';

let next = 0;

/** A group of one call, with the A/A copy that benk adds */
function alone(name: string, run: () => unknown): Group {
    return { name, variants: [{ name, run }] };
}

await bench([
    alone('nothing', () => next),
    alone('a small object', () => ({ value: next++ })),
    alone('number[] of 128', () => new Array<number>(128).fill(next++)),
    alone('Float64Array of 1 KiB', () => new Float64Array(128)),
    alone('Float64Array of 8 KiB', () => new Float64Array(1024)),
    alone('Float64Array of 100 KiB', () => new Float64Array(12_800)),
    alone('Float64Array of 1 MiB', () => new Float64Array(131_072))
]);
