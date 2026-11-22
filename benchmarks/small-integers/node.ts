// The benchmark of small integers' width in Node, whose small integers have
// 32 bits, as `groups.ts` describes. Run it with
// `node --no-strip-types --import @snovader/node-hooks/register
// benchmarks/small-integers/node.ts`, and `--sample-ms 10` for rounds in
// which Turbofan compiles the timer loops.
import { bench } from 'benk';
import { groups } from './groups.ts';

await bench(groups);
