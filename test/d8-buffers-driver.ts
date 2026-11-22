// A script that `d8.test.ts` bundles and runs in d8, with or without the
// flags that a count of array buffers needs: it measures a group with a
// `D8Runtime`, and prints the run's results as JSON. Each of d8's arguments
// is a variant, as `<length>x<objects>`: each call allocates a `Uint8Array`
// of the length, and as many small objects, which start scavenges during
// samples of many calls.
import { measureGroups, type SyncVariant } from 'benk/core';
import { D8Runtime } from 'benk/d8';

let buffer: Uint8Array | undefined;
let object: object | undefined;

function allocating(argument: string): SyncVariant {
    const [length, objects] = argument.split('x').map(Number);

    return {
        name: argument,
        run: () => {
            buffer = new Uint8Array(length);
            for (let i = 0; i < objects; i++) {
                object = { i };
            }
            return [buffer, object];
        }
    };
}

const args = (globalThis as unknown as { arguments: readonly string[] })
    .arguments;

const result = await measureGroups(
    [{ name: 'buffers', variants: args.map(allocating), aa: false }],
    { runtime: new D8Runtime(), sampleTime: 1, warmupRounds: 2, rounds: 6 }
);
console.log(JSON.stringify(result));
