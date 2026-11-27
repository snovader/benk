import { quantile } from './statistics.ts';
import type { TimedVariant } from './timed-variant.ts';
import type { ArrayBufferMeter } from './types.ts';

/**
 * Samples of a variant's bytes of array buffers, of which the median counts,
 * as of its heap bytes. A sample can count too few, but not too many: V8
 * frees the buffers of a collection on a background thread after it, and
 * those that it frees during a later sample take that sample's count down
 * without a collection that the meter could see. In Node 24, 26 and 27 on
 * an Apple M2 Pro, 20 counts each of 12 calls that allocated nothing to
 * 16 MiB in buffers had 3,600 samples that counted, after Node's runtime
 * settled, none too few and none too many. With one wait before each
 * sample, 26 of 1,800 counted too few, up to all of a sample's calls, and
 * the median of each count was still right.
 */
const SAMPLES = 5;

/**
 * The samples that a count takes at most, counted or not. Each sample that
 * the meter can't count halves the calls of the next, so that a sample
 * allocates too little to start a collection: 21 halve a round of 2²¹
 * calls to a single call. In the counts above, a count took 5 to 15
 * samples.
 */
const ATTEMPTS = 40;

/**
 * The bytes of array buffers' contents that a call of the variant allocates
 * outside the heap, with the variant's own timer loop: the median of
 * `SAMPLES` samples that the meter could count, or null if it couldn't count
 * that many in `ATTEMPTS`, as when each call starts a garbage collection.
 *
 * The first sample has a round's calls. A collection during one frees
 * buffers, which the meter can't count, so the sample doesn't count, and the
 * next has half as many calls, until one allocates too little to start a
 * collection. The meter settles before each, so that buffers that V8 frees
 * after a collection are freed before the sample starts.
 *
 * Unlike heap bytes, there's no baseline: neither the timer loop nor the
 * meter allocates a buffer, and an empty loop counted 0 bytes in every
 * sample.
 */
export async function arrayBufferBytesPerCall(
    meter: ArrayBufferMeter,
    variant: TimedVariant
): Promise<number | null> {
    const perCall = new Float64Array(SAMPLES);
    let counted = 0;
    let repetitions = variant.repetitions();

    for (let attempt = 0; attempt < ATTEMPTS && counted < SAMPLES; attempt++) {
        await meter.settle();
        const bytes = await variant.allocated(meter, repetitions);

        if (bytes == null) {
            repetitions = Math.ceil(repetitions / 2);
        } else {
            perCall[counted++] = bytes / repetitions;
        }
    }

    if (counted < SAMPLES) {
        return null;
    }

    perCall.sort();
    return quantile(perCall, 0.5);
}
