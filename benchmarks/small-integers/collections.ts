// Counts the scavenges of each variant of `groups.ts`, and the bytes that its
// calls allocate, apart from the timed runs: V8's `--trace-gc-nvp` prints a
// line for each collection, which would be timed with the calls. d8 has no
// API that counts heap bytes, but each line has the bytes allocated since the
// collection before it.
//
// It calls each variant 10,000 times, one after another, and prints the
// variant's name after `## ` before its calls, so the lines between two names
// are the collections of the first one's calls. Run it in Node with
// `node --no-strip-types --import @snovader/node-hooks/register
// --trace-gc-nvp benchmarks/small-integers/collections.ts`, and in d8 with
// `d8 --trace-gc-nvp` on a bundle of it, as `d8.ts` describes. This prints
// each variant's scavenges and bytes per call from either's output:
// `awk -v calls=10000 '/"gc":"s"/ { n++ } match($0, /"allocated":[0-9]+/) { b += substr($0, RSTART + 12, RLENGTH - 12) } /^## / { if (name) print n + 0, b / calls, name; name = substr($0, 4); n = b = 0 }'`
//
// The bytes of a variant's first collection include what the variant before
// it allocated after its last, so a count is off by up to the young
// generation's capacity, of a few MiB, over 10,000 calls.
import { groups } from './groups.ts';

const CALLS = 10_000;

/** Calls each variant, and prints its name first when `print` is set */
function callEach(print: boolean): void {
    for (const { name, variants } of groups) {
        for (const variant of variants) {
            if (print) {
                console.log(`## ${name}: ${variant.name}`);
            }
            for (let i = 0; i < CALLS; i++) {
                variant.run();
            }
        }
    }
}

// V8 grows the young generation in the first collections of a process, so
// a pass that isn't counted comes first, rather than counting more
// collections for the first variant than for the others
callEach(false);
callEach(true);
console.log('## end');
