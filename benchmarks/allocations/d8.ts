// The benchmark of what benk counts of calls that allocate, in d8, the V8
// shell, as `groups.ts` describes. d8 counts array buffers only with three
// of its flags, and reads an import as a path, so bundle the script first,
// and run the bundle with them:
// `yarn rolldown benchmarks/allocations/d8.ts --file /tmp/allocations.mjs`
// and `d8 --expose-statistics --expose-gc --allow-natives-syntax
// /tmp/allocations.mjs`, with benk's options after `--`.
import { bench } from 'benk/d8';
import { groups } from './groups.ts';

await bench(groups);
