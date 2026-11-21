// A script that `d8.test.ts` bundles and runs in d8: it times a group of a
// sync and an async variant with d8's runtime, and prints its results, the
// run's description and the group's table, as JSON
import { describeRun, formatGroup, measureGroups } from 'benk/core';
import { D8Runtime } from 'benk/d8';

let count = 0;
const result = await measureGroups(
    [
        {
            name: 'calls',
            variants: [
                { name: 'sync', run: () => (count = (count + 1) % 1024) },
                {
                    name: 'async',
                    async: true,
                    run: () => Promise.resolve(count)
                }
            ]
        }
    ],
    { runtime: new D8Runtime(), sampleTime: 0.2, warmupRounds: 2, rounds: 6 }
);

console.log(
    JSON.stringify({
        result,
        description: describeRun(result.runtime, result.options),
        table: formatGroup(result.groups[0])
    })
);
