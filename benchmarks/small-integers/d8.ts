// The benchmark of small integers' width in d8, the V8 shell, whose small
// integers have 31 bits, as `groups.ts` describes. d8 reads an import as a
// path, so bundle it first, and run the bundle:
// `yarn rolldown benchmarks/small-integers/d8.ts --file /tmp/small-integers.mjs`
// and `d8 /tmp/small-integers.mjs`, with `-- --sample-ms 10` or
// `-- --sample-ms=10` for rounds in which Turbofan compiles the timer loops.
// It takes no other argument.
import { describeRun, formatGroup, measureGroups } from 'benk/core';
import { D8Runtime } from 'benk/d8';
import { groups } from './groups.ts';

/** The one option that this script reads, as `bench()` reads it in Node */
const SAMPLE_MS = '--sample-ms';

/**
 * Reads the time of one variant's round from d8's arguments, as
 * `--sample-ms <ms>` or `--sample-ms=<ms>`, the forms that `node.ts` takes.
 * `benk/d8` has no `bench()` to read a command line, so an argument that
 * this doesn't read would otherwise leave a run at its defaults, unnoticed.
 * `measureGroups()` checks that the time is a positive number.
 *
 * @throws {TypeError} If an argument isn't `--sample-ms`, or it has no value.
 */
function sampleTimeOf(args: readonly string[]): number | undefined {
    let value: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith(`${SAMPLE_MS}=`)) {
            value = arg.slice(SAMPLE_MS.length + 1);
        } else if (arg === SAMPLE_MS && i + 1 < args.length) {
            i++;
            value = args[i];
        } else {
            throw new TypeError(
                `Expected ${SAMPLE_MS} <ms> or ${SAMPLE_MS}=<ms>, got ${arg}`
            );
        }
    }

    return value == null ? undefined : Number(value);
}

/** The arguments after `--` on d8's command line, a global of d8's */
const args = (globalThis as unknown as { arguments: readonly string[] })
    .arguments;

const result = await measureGroups(groups, {
    runtime: new D8Runtime(),
    sampleTime: sampleTimeOf(args)
});

console.log(describeRun(result.runtime, result.options));
for (const group of result.groups) {
    console.log(`\n${formatGroup(group).join('\n')}`);
}
