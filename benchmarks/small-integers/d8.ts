// The benchmark of small integers' width in d8, the V8 shell, whose small
// integers have 31 bits, as `groups.ts` describes. d8 reads an import as a
// path, so bundle it first, and run the bundle:
// `yarn rolldown benchmarks/small-integers/d8.ts --file /tmp/small-integers.mjs`
// and `d8 /tmp/small-integers.mjs`, with `-- --sample-ms 10` for rounds in
// which Turbofan compiles the timer loops.
import { describeRun, formatGroup, measureGroups } from 'benk/core';
import { D8Runtime } from 'benk/d8';
import { groups } from './groups.ts';

/** The arguments after `--` on d8's command line, a global of d8's */
const args = (globalThis as unknown as { arguments: readonly string[] })
    .arguments;

const at = args.indexOf('--sample-ms');
const sampleTime = at === -1 ? undefined : Number(args[at + 1]);

const result = await measureGroups(groups, {
    runtime: new D8Runtime(),
    sampleTime
});

console.log(describeRun(result.runtime, result.options));
for (const group of result.groups) {
    console.log(`\n${formatGroup(group).join('\n')}`);
}
