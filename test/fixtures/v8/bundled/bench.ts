// The benchmark whose bundle, `bench.mjs`, is this directory's fixture, with
// its source map, `bench.mjs.map`, which `capture.ts` writes. Its variants
// call the functions of another module, `sum.ts`, which the bundle has in
// it, and one deoptimizes, so that the report has positions of each kind in
// both sources.
import { bench } from 'benk';
import { mean, sum } from './sum.ts';

const SIZE = 1000;

const integers = Array.from({ length: SIZE }, (_, i) => i);
const doubles = Array.from({ length: SIZE }, (_, i) => i + 0.5);

let calls = 0;

await bench([
    {
        name: 'bundled',
        variants: [
            { name: 'sum', run: () => sum(integers) },
            { name: 'mean', run: () => mean(integers) },
            {
                // Integers, and then doubles, for which the code that V8
                // compiled for integers deoptimizes
                name: 'switching',
                run: () => sum(++calls < 20_000 ? integers : doubles)
            }
        ]
    }
]);
