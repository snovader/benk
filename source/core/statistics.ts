import type { Modes, Summary } from './types.ts';

/** The share of the rounds that each of two modes needs at least */
const MODE_SHARE = 0.1;

/** The rounds that each of two modes needs at least */
const MODE_ROUNDS = 3;

/**
 * How much slower the slow mode's median needs to be than the fast one's, at
 * least: closer modes change what the median and the fastest say only a
 * little
 */
const MODE_DIFFERENCE = 0.05;

/**
 * How far apart the modes' medians need to be, at least, in multiples of the
 * mean of their interquartile ranges, all in logarithms. A normal sample
 * split at its middle comes to about 2, and a long tail split from the rest
 * to about 3.
 */
const MODE_SEPARATION = 4;

/**
 * Summarizes samples: the fastest and slowest, the quartiles, the spread
 * between them, and two modes, if they form two
 *
 * @throws {RangeError} If there are no samples.
 */
export function summarize(samples: ArrayLike<number>): Summary {
    if (samples.length === 0) {
        throw new RangeError('Expected at least one sample');
    }

    const sorted = sortedCopy(samples);
    const q1 = quantile(sorted, 0.25);
    const median = quantile(sorted, 0.5);
    const q3 = quantile(sorted, 0.75);

    return {
        fastest: quantile(sorted, 0),
        q1,
        median,
        q3,
        slowest: quantile(sorted, 1),
        spread: q3 === q1 ? 0 : (q3 - q1) / median,
        modes: modesOf(sorted)
    };
}

/** Numbers sorted in a copy, as numbers rather than as strings */
export function sortedCopy(numbers: ArrayLike<number>): Float64Array {
    const sorted = Float64Array.from(numbers);
    sorted.sort();

    return sorted;
}

/**
 * The sample at `p` of the way through sorted samples, or the slower of the
 * two around it, so that every quantile is a sample, and the median of an
 * even count is the slower of the middle two
 */
export function quantile(sorted: ArrayLike<number>, p: number): number {
    return sorted[Math.ceil(p * (sorted.length - 1))];
}

/**
 * Two modes of sorted positive samples, or null if they don't form two. It
 * splits their logarithms where the two parts' means are furthest apart for
 * their sizes, as Otsu's method does, then assigns each sample to the part
 * whose median is nearer, so that a few outliers can't borrow samples of the
 * other mode to make up a part. They're two modes when each part has enough
 * samples, and the parts' medians are far apart for the parts' own spread.
 * Logarithms, since a call's time varies by a factor rather than by an
 * amount.
 */
export function modesOf(sorted: Float64Array): Modes | null {
    const count = sorted.length;
    const least = Math.max(MODE_ROUNDS, Math.ceil(count * MODE_SHARE));
    if (count < 2 * least || !(sorted[0] > 0)) {
        return null;
    }

    const first = bestSplit(sorted.map(Math.log), least);
    const middle = Math.sqrt(
        quantile(sorted.subarray(0, first), 0.5) *
            quantile(sorted.subarray(first), 0.5)
    );
    const split = sorted.findIndex(sample => sample >= middle);
    if (split < least || count - split < least) {
        return null;
    }

    const fast = sorted.subarray(0, split);
    const slow = sorted.subarray(split);
    const fastMedian = quantile(fast, 0.5);
    const slowMedian = quantile(slow, 0.5);
    const width = (logRange(fast) + logRange(slow)) / 2;

    if (
        slowMedian < fastMedian * (1 + MODE_DIFFERENCE) ||
        Math.log(slowMedian / fastMedian) < MODE_SEPARATION * width
    ) {
        return null;
    }

    return {
        fast: { median: fastMedian, rounds: fast.length },
        slow: { median: slowMedian, rounds: slow.length }
    };
}

/**
 * Where to split sorted values into two parts of at least `least` values
 * each, so that the variance between the parts is the greatest: the count of
 * the first part
 */
function bestSplit(sorted: Float64Array, least: number): number {
    const count = sorted.length;
    const total = sorted.reduce((sum, value) => sum + value, 0);

    let best = least;
    let bestScore = -1;
    let prefix = 0;
    for (let split = 1; split <= count - least; split++) {
        prefix += sorted[split - 1];
        if (split >= least) {
            const difference =
                (total - prefix) / (count - split) - prefix / split;
            const score = split * (count - split) * difference * difference;

            if (score > bestScore) {
                best = split;
                bestScore = score;
            }
        }
    }

    return best;
}

/** The interquartile range of sorted positive samples, in logarithms */
function logRange(sorted: Float64Array): number {
    return Math.log(quantile(sorted, 0.75) / quantile(sorted, 0.25));
}

/**
 * A confidence interval of the median of sorted samples, from their order
 * statistics: the median is below the k-th sample when at most k − 1 samples
 * are, which a binomial distribution of p = 1/2 describes. It assumes only
 * that the samples are independent, so it holds for samples of any
 * distribution. Its coverage is at least `confidence`, and more for a small
 * count, as the binomial is discrete.
 *
 * @returns The interval, or null if too few samples give one: under 6, for
 * a 95% interval.
 */
export function medianInterval(
    sorted: ArrayLike<number>,
    confidence = 0.95
): readonly [low: number, high: number] | null {
    const count = sorted.length;
    const tail = (1 - confidence) / 2;

    // The greatest k whose probability of at most k − 1 samples below the
    // median is within the tail, summed in logarithms, which don't underflow
    // as 2^-count does
    let k = 0;
    let cumulative = 0;
    let logProbability = -count * Math.LN2;
    while (k < count) {
        const next = cumulative + Math.exp(logProbability);
        if (next > tail) {
            break;
        }

        cumulative = next;
        logProbability += Math.log((count - k) / (k + 1));
        k++;
    }

    return k === 0 ? null : [sorted[k - 1], sorted[count - k]];
}

/** Each sample's ratio to the reference's sample at the same index */
export function pairedRatios(
    samples: ArrayLike<number>,
    reference: ArrayLike<number>
): Float64Array {
    const ratios = new Float64Array(samples.length);
    for (let i = 0; i < ratios.length; i++) {
        ratios[i] = samples[i] / reference[i];
    }

    return ratios;
}
