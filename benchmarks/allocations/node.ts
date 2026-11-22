// The benchmark of what benk counts of calls that allocate, in Node, as
// `groups.ts` describes. Run it with `node --no-strip-types --import
// @snovader/node-hooks/register benchmarks/allocations/node.ts`.
import { bench } from 'benk';
import { groups } from './groups.ts';

await bench(groups);
