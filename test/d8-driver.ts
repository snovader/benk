// A script that `d8.test.ts` bundles and runs in d8: it runs `bench()` of
// `benk/d8` with the arguments that d8 passes it, on a group of a sync and
// an async variant, and on a group whose variant throws. If `bench()`
// throws, it prints the error, and the variants' calls until then, as JSON
// on the last line of stdout.
import { bench } from 'benk/d8';

let calls = 0;
try {
    await bench([
        {
            name: 'calls',
            variants: [
                { name: 'sync', run: () => calls++ },
                {
                    name: 'async',
                    async: true,
                    run: () => Promise.resolve(calls++)
                }
            ]
        },
        {
            name: 'throws',
            variants: [
                {
                    name: 'throw',
                    run: () => {
                        throw new Error('Thrown by the variant');
                    }
                }
            ]
        }
    ]);
} catch (error) {
    console.log(JSON.stringify({ error: String(error), calls }));
}
