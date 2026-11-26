// A benchmark script whose `after` prints a line of its own after the
// tables, which `cli.test.ts` runs to see where the line goes.
import { bench } from 'benk';

let calls = 0;

await bench(
    [{ name: 'calls', variants: [{ name: 'count', run: () => calls++ }] }],
    {
        after: (print, { groups }) => {
            print(`${groups.length} group measured`);
        }
    }
);
