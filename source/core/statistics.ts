import type { Change, Modes, PositionEffect, Summary } from './types.ts';

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
 * How far the rank sum of a variant's rounds in one position needs to be
 * from its mean, at least, in standard deviations, for a position effect.
 * A position has few rounds, 6 to 12 of 31 over 3 to 7 positions, and the
 * furthest of several is often far by chance. With the rotation's positions
 * at 31 rounds, 50,000 shuffles of rounds whose order doesn't matter gave
 * 0.05% to 0.18% of variants of 2 to 7 positions an effect at 3.3, and
 * 0.02% to 0.06% at 3.5. At 3.7, with both thresholds, 200,000 shuffles
 * gave 0.002% to 0.019% at 31 rounds, 32 to 42 in whole rotations, and
 * 0.024% to 0.090% at 120 to 126. A position whose rounds are all slower
 * than the others' reaches 3.7 with up to 7 positions of 6 rounds. On an Apple M2 Pro with Node 26.13.0, of 852 variants in 96 runs
 * of the README's quick start, `examples/numbers.ts` and `benchmarks/`,
 * with load averages near 5 and of 30 to 47, 4 had an effect at 3.3, 1 of
 * them an A/A copy, and 1 at 3.7, none of them an A/A copy.
 */
const POSITION_SIGNIFICANCE = 3.7;

/**
 * The share of the rounds, at least, whose mode agrees with whether a cause
 * picks them, for the cause to explain two modes, as `modesAreOf()` tells.
 * It allows a round in ten to fall in the other mode, as noise moves a round
 * across the middle when the modes are close for their spread. In 5,000
 * simulated runs of 36 rounds, with one of 3 positions at twice the time and
 * noise of 2% in the logarithms, the modes agreed with the position in every
 * round.
 */
const MODES_AGREEMENT = 0.9;

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

    const order = orderByTime(samples);
    const ranks = ranksOf(samples, order);
    const logs = samples.map(Math.log);
    const logTotal = logs.reduce((sum, log) => sum + log, 0);
    const offsets = new Int32Array(count);
    for (const [offset, round] of order.entries()) {
        offsets[round] = offset;
    }
    const firstMedians = runningMedians(samples, order, offsets, 'prefix');
    const lastMedians = runningMedians(samples, order, offsets, 'suffix');

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
    const { distance, separation } = compareRanks(rankSum, before, count);

    return distance >= CHANGE_SIGNIFICANCE && separation >= CHANGE_SEPARATION;
}

/** How some of the rounds compare with the others, by their ranks */
interface RankComparison {
    /**
     * How far the rank sum of those rounds is from its mean for rounds
     * whose order doesn't matter, in standard deviations, either way
     */
    readonly distance: number;
    /**
     * The share of the pairs of one of those rounds and one of the others
     * that are ordered as the greater part of them are, from 0.5 to 1
     */
    readonly separation: number;
}

/**
 * How `size` of `count` rounds, whose ranks among them sum to `rankSum`,
 * compare with the others, as Mann and Whitney's test compares two parts
 */
function compareRanks(
    rankSum: number,
    size: number,
    count: number
): RankComparison {
    const pairs = size * (count - size);
    // The pairs whose round of the `size` is the slower, with a tie as half,
    // as Mann and Whitney's U counts them
    const slower = rankSum - (size * (size + 1)) / 2;

    return {
        distance: Math.abs(
            (slower - pairs / 2) / Math.sqrt((pairs * (count + 1)) / 12)
        ),
        separation: Math.max(slower, pairs - slower) / pairs
    };
}

/**
 * A position in the round whose rounds took longer or shorter than a
 * variant's others, or null if none did. Each position has as many rounds,
 * as the rotation balances them. It compares the rounds in each position
 * with the others by their ranks, as Mann and Whitney's test does. Among
 * positions passing both the rank distance and median difference thresholds,
 * it takes the greatest distance, with the first position breaking a tie.
 *
 * It finds none unless every sample is positive, as `changeOf()` does. A
 * sample of 0 is a round that took less than the clock's tick, as with a
 * coarse clock, whose times are too few to rank by position, and which the
 * table's note of the timer's resolution flags. A sample that isn't a number
 * ranks nowhere.
 */
export function positionEffectOf(
    samples: Float64Array,
    positions: ArrayLike<number>
): PositionEffect | null {
    if (!samples.every(sample => sample > 0)) {
        return null;
    }

    const count = samples.length;
    const order = orderByTime(samples);
    const ranks = ranksOf(samples, order);
    const rankSums: number[] = [];
    const byPosition: number[][] = [];
    for (const [offset, round] of order.entries()) {
        const position = positions[round];
        (byPosition[position] ??= []).push(offset);
        rankSums[position] = (rankSums[position] ?? 0) + ranks[round];
    }

    let best: PositionEffect | null = null;
    let greatest = 0;
    for (const [position, offsets] of byPosition.entries()) {
        if (offsets.length === count) {
            return null;
        }
        const { distance } = compareRanks(
            rankSums[position],
            offsets.length,
            count
        );
        if (distance < POSITION_SIGNIFICANCE || distance <= greatest) {
            continue;
        }

        const median = samples[order[quantile(offsets, 0.5)]];
        const others = samples[order[otherMedianOffset(count, offsets)]];
        if (areApart(median, others)) {
            best = { position, median, others };
            greatest = distance;
        }
    }

    return best;
}

/** The upper median's offset in sorted rounds after excluding one position */
function otherMedianOffset(count: number, excluded: readonly number[]): number {
    let middle = Math.floor((count - excluded.length) / 2);
    // Each excluded round at or before the target moves it one place right.
    for (const offset of excluded) {
        if (offset > middle) {
            break;
        }
        middle++;
    }

    return middle;
}

/**
 * Whether two modes of samples are the rounds that `selected` picks and the
 * others, as when a position's rounds are the slow mode: nearly every picked
 * round in one mode, and nearly every other round in the other. A round is
 * in the mode on its side of the geometric mean of the modes' medians.
 */
export function modesAreOf(
    samples: ArrayLike<number>,
    { fast, slow }: Modes,
    selected: (round: number) => boolean
): boolean {
    const middle = Math.sqrt(fast.median * slow.median);
    let slowPicked = 0;
    let picked = 0;
    for (let round = 0; round < samples.length; round++) {
        if (selected(round)) {
            picked++;
            slowPicked += samples[round] >= middle ? 1 : 0;
        }
    }
    // The mode that the picked rounds are in, most of them
    const pickedSlow = slowPicked * 2 >= picked;

    let agree = 0;
    for (let round = 0; round < samples.length; round++) {
        const isSlow = samples[round] >= middle;
        agree += isSlow === (selected(round) === pickedSlow) ? 1 : 0;
    }

    return agree >= MODES_AGREEMENT * samples.length;
}

/** Whether two positive medians are `PART_DIFFERENCE` or more apart */
function areApart(a: number, b: number): boolean {
    return Math.max(a, b) >= Math.min(a, b) * (1 + PART_DIFFERENCE);
}

/**
 * The upper median for every prefix or suffix, indexed by its length minus
 * one. Start with all rounds sorted and remove one end of the time series
 * at a time. Deleting a round moves the median at most one surviving
 * neighbor, so all medians take linear time once the rounds are sorted.
 */
function runningMedians(
    samples: Float64Array,
    order: Int32Array,
    offsets: Int32Array,
    segment: 'prefix' | 'suffix'
): Float64Array {
    const count = samples.length;
    const previous = new Int32Array(count);
    const next = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        previous[i] = i - 1;
        next[i] = i + 1;
    }

    const medians = new Float64Array(count);
    let middle = Math.floor(count / 2);
    for (let size = count; size > 0; size--) {
        medians[size - 1] = samples[order[middle]];
        const round = segment === 'prefix' ? size - 1 : count - size;
        const removed = offsets[round];
        if (size % 2 === 0 && removed >= middle) {
            middle = previous[middle];
        } else if (size % 2 === 1 && removed <= middle) {
            middle = next[middle];
        }

        const left = previous[removed];
        const right = next[removed];
        if (left >= 0) {
            next[left] = right;
        }
        if (right < count) {
            previous[right] = left;
        }
    }

    return medians;
}

/** Round indices in ascending sample order */
function orderByTime(samples: Float64Array): Int32Array {
    const order = Int32Array.from({ length: samples.length }, (_, i) => i);
    return order.sort((a, b) => samples[a] - samples[b]);
}

/**
 * Each sample's rank among them, from 1 for the fastest, with tied samples
 * taking the mean of their ranks
 */
function ranksOf(samples: Float64Array, order: Int32Array): Float64Array {
    const count = samples.length;
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
