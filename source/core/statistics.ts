import type { Change, Modes, Summary } from './types.ts';

/**
 * The share of the rounds that each of two parts needs at least: each of two
 * modes, and the rounds before and after a change
 */
const PART_SHARE = 0.1;

/** The rounds that each of two parts needs at least */
const PART_ROUNDS = 3;

/**
 * How much slower the slower part's median needs to be than the faster
 * one's, at least: closer parts change what the median and the fastest say
 * only a little
 */
const PART_DIFFERENCE = 0.05;

/**
 * How far apart the modes' medians need to be, at least, in multiples of the
 * mean of their interquartile ranges, all in logarithms. A normal sample
 * split at its middle comes to about 2, and a long tail split from the rest
 * to about 3.
 */
const MODE_SEPARATION = 4;

/**
 * How many of the pairs of a round before a change and a round after it need
 * to be ordered as the two parts' medians are, at least, as a share of the
 * pairs. With the other tests, 50,000 shuffles each of 31 to 40 rounds,
 * whose order doesn't matter, found a change in 0.40% to 0.57% of them at
 * 0.9, and 100,000 in 0.13% to 0.17% at 0.95. On an Apple M2 Pro with Node
 * 26.13.0, in 6 runs of the README's quick start with `--sample-ms 10` and
 * a load average near 5, the for loop's first 4 to 7 rounds, before
 * Turbofan's code took over, were separated from the rest by 1, in both
 * its variants. Under a load average of 30 to 47, they were in 9 of 12
 * variants by 0.96 to 1, and in the others by 0.92 to 0.95, as load slowed
 * some later rounds as much.
 */
const CHANGE_SEPARATION = 0.95;

/**
 * How far the rank sum of the rounds before a change needs to be from its
 * mean for rounds whose order doesn't matter, at least, in standard
 * deviations. In few rounds, a split is separated by chance too often:
 * without it, shuffles of 8 to 12 rounds had a change in 5.4% to 9.2% of
 * them, and of 16 to 20 in 1.9% to 2.6%. With it, 100,000 shuffles of each
 * count found none in 12 rounds or fewer, where no split can be that far,
 * and a change in 0.24% to 0.58% of 13 to 24 rounds, 0.13% to 0.17% of 31
 * to 40, and 0.006% of 60.
 */
const CHANGE_SIGNIFICANCE = 3;

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
    const least = leastRounds(count);
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
        slowMedian < fastMedian * (1 + PART_DIFFERENCE) ||
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

/** The rounds that each of two parts of `count` rounds needs at least */
function leastRounds(count: number): number {
    return Math.max(PART_ROUNDS, Math.ceil(count * PART_SHARE));
}

/**
 * A change partway through positive samples in the rounds' order, or null if
 * they didn't change: the rounds before it differ from those after it by
 * more than their own spread, as when V8's optimized code takes over after
 * the first rounds, or load from other processes starts or stops.
 *
 * It tests each split of the rounds by their ranks, as Mann and Whitney's
 * test compares two parts, which hold for samples of any distribution, and
 * in which an outlier counts as any slow round. A split can be a change
 * when each part has enough rounds, as each of two modes needs, the rank
 * sum of the rounds before it is far enough from its mean, the parts are
 * separated, with their pairs of a round before and a round after nearly
 * all ordered alike, and their medians are far enough apart. Of those, it
 * takes the split whose parts' means of the logarithms differ the most for
 * their sizes, as Otsu's method splits the modes: ranks tell whether the
 * rounds changed, but rounds that drift after a change can rank as if
 * before it. The split that's furthest from its mean alone can be a drift
 * of a few percent over many rounds, which would hide a large change in a
 * few.
 */
export function changeOf(samples: Float64Array): Change | null {
    const count = samples.length;
    const least = leastRounds(count);
    if (count < 2 * least || !samples.every(sample => sample > 0)) {
        return null;
    }

    const ranks = ranksOf(samples);
    const logs = samples.map(Math.log);
    const logTotal = logs.reduce((sum, log) => sum + log, 0);
    const firstMedians = runningMedians(samples);
    const lastMedians = runningMedians(samples.toReversed());

    let best = 0;
    let bestScore = 0;
    let rankSum = 0;
    let logSum = 0;
    for (let before = 1; before <= count - least; before++) {
        rankSum += ranks[before - 1];
        logSum += logs[before - 1];
        if (
            before >= least &&
            isSeparated(rankSum, before, count) &&
            areApart(firstMedians[before - 1], lastMedians[count - before - 1])
        ) {
            const after = count - before;
            const difference = (logTotal - logSum) / after - logSum / before;
            const score = before * after * difference * difference;

            if (score > bestScore) {
                best = before;
                bestScore = score;
            }
        }
    }
    if (best === 0) {
        return null;
    }

    return {
        before: { median: firstMedians[best - 1], rounds: best },
        after: { median: lastMedians[count - best - 1], rounds: count - best }
    };
}

/**
 * Whether the rounds before a split, whose ranks sum to `rankSum`, are far
 * enough from its mean, and separated from those after it
 */
function isSeparated(rankSum: number, before: number, count: number): boolean {
    const pairs = before * (count - before);
    // The pairs whose round before the split is the slower, with a tie as
    // half, as Mann and Whitney's U counts them
    const slower = rankSum - (before * (before + 1)) / 2;
    const distance =
        (slower - pairs / 2) / Math.sqrt((pairs * (count + 1)) / 12);
    const separation = Math.max(slower, pairs - slower) / pairs;

    return (
        Math.abs(distance) >= CHANGE_SIGNIFICANCE &&
        separation >= CHANGE_SEPARATION
    );
}

/** Whether two positive medians are `PART_DIFFERENCE` or more apart */
function areApart(a: number, b: number): boolean {
    return Math.max(a, b) >= Math.min(a, b) * (1 + PART_DIFFERENCE);
}

/**
 * The median of each count of the first samples, at that count less one, as
 * `quantile()` takes it. It keeps them sorted by insertion, whose moves cost
 * less than sorting each count anew.
 */
function runningMedians(samples: Float64Array): Float64Array {
    const sorted = new Float64Array(samples.length);
    const medians = new Float64Array(samples.length);
    for (const [count, sample] of samples.entries()) {
        let low = 0;
        let high = count;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (sorted[middle] < sample) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        sorted.copyWithin(low + 1, low, count);
        sorted[low] = sample;
        medians[count] = sorted[Math.ceil(count / 2)];
    }

    return medians;
}

/**
 * Each sample's rank among them, from 1 for the fastest, with tied samples
 * taking the mean of their ranks
 */
function ranksOf(samples: ArrayLike<number>): Float64Array {
    const count = samples.length;
    const order = Int32Array.from({ length: count }, (_, i) => i);
    order.sort((a, b) => samples[a] - samples[b]);

    const ranks = new Float64Array(count);
    for (let first = 0; first < count;) {
        let last = first;
        while (
            last + 1 < count &&
            samples[order[last + 1]] === samples[order[first]]
        ) {
            last++;
        }

        const rank = (first + last) / 2 + 1;
        for (let i = first; i <= last; i++) {
            ranks[order[i]] = rank;
        }
        first = last + 1;
    }

    return ranks;
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
