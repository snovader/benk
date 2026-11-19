// An example benchmark: sums and sorts of 1,000 numbers. Run it with
// `node examples/numbers.ts`, and add `--json results.json` to write the
// results as JSON too, or `--json -` to write them to stdout.
import { main, type SyncVariant } from 'benk';

const SIZE = 1000;

const numbers = Array.from({ length: SIZE }, (_, i) => Math.sin(i));
const floats = Float64Array.from(numbers);

function sumArray(values: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }

    return sum;
}

function sumFloats(values: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }

    return sum;
}

/**
 * A variant that sorts a copy of the numbers in place, which it copies in its
 * setup, untimed: one copy for each call of a round
 */
function sortVariant<T>(
    name: string,
    copy: () => T,
    sort: (values: T) => unknown
): SyncVariant {
    let copies: T[] = [];
    let next = 0;

    return {
        name,
        setup: calls => {
            copies = Array.from({ length: calls }, copy);
            next = 0;
        },
        run: () => sort(copies[next++])
    };
}

await main([
    {
        name: `sum ${SIZE.toLocaleString('en-US')} numbers`,
        variants: [
            { name: 'for over number[]', run: () => sumArray(numbers) },
            { name: 'for over Float64Array', run: () => sumFloats(floats) },
            {
                name: 'reduce',
                run: () => numbers.reduce((sum, value) => sum + value, 0)
            }
        ]
    },
    {
        name: `sort ${SIZE.toLocaleString('en-US')} numbers`,
        variants: [
            sortVariant(
                'Float64Array',
                () => floats.slice(),
                values => {
                    values.sort();
                }
            ),
            // Array's sort() compares strings unless given a comparison
            sortVariant(
                'number[]',
                () => numbers.slice(),
                values => {
                    values.sort((a, b) => a - b);
                }
            )
        ]
    }
]);
