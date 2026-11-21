import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { medianInterval, summarize } from 'benk';
import { modesOf, sortedCopy } from '#source/core/statistics';
import { expectPresent } from './expectations.ts';

const sample = fc.double({ min: 1e-3, max: 1e9, noNaN: true });

/**
 * The count k of the 95% interval of the median of `count` samples, from
 * exact binomial sums: the greatest k for which at most k − 1 samples are
 * below the median with a probability of at most 2.5%, or 0 if none is
 */
function exactIntervalRank(count: number): number {
    const total = 1n << BigInt(count);
    let coefficient = 1n;
    let cumulative = 0n;
    let k = 0;
    while (k < count && (cumulative + coefficient) * 40n <= total) {
        cumulative += coefficient;
        coefficient = (coefficient * BigInt(count - k)) / BigInt(k + 1);
        k++;
    }

    return k;
}

/** `count` samples spread evenly from `low` to `high`, by factors */
function evenly(count: number, low: number, high: number): number[] {
    return Array.from(
        { length: count },
        (_, i) => low * (high / low) ** (i / Math.max(1, count - 1))
    );
}

describe('summarize', () => {
    it.prop([fc.array(sample, { minLength: 1, maxLength: 200 })])(
        'summarizes samples with statistics that are samples, in order',
        samples => {
            const { fastest, q1, median, q3, slowest, spread } = summarize(samples);

            expect(fastest).toBe(Math.min(...samples));
            expect(slowest).toBe(Math.max(...samples));
            expect(fastest <= q1 && q1 <= median && median <= q3 && q3 <= slowest).toBe(true);
            for (const statistic of [q1, median, q3]) {
                expect(samples).toContain(statistic);
            }
            expect(spread).toBe(q3 === q1 ? 0 : (q3 - q1) / median);
        }
    );

    it('takes the slower of the middle two as the median of an even count', () => {
        expect(summarize([4, 1, 3, 2]).median).toBe(3);
        expect(summarize([1, 2]).median).toBe(2);
        expect(summarize([5, 1, 3]).median).toBe(3);
    });

    it('rejects no samples', () => {
        expect(() => summarize([])).toThrow(RangeError);
    });
});

describe('medianInterval', () => {
    it('takes the order statistics that exact binomial sums give', () => {
        for (let count = 1; count <= 300; count++) {
            const sorted = Array.from({ length: count }, (_, i) => i);
            const k = exactIntervalRank(count);

            expect(medianInterval(sorted), `${count} samples`).toStrictEqual(
                k === 0 ? null : [k - 1, count - k]
            );
        }
    });

    it('gives no 95% interval of fewer than 6 samples, and the extremes of 6', () => {
        expect(medianInterval([1, 2, 3, 4, 5])).toBeNull();
        expect(medianInterval([1, 2, 3, 4, 5, 6])).toStrictEqual([1, 6]);
    });

    it.prop([fc.array(sample, { minLength: 6, maxLength: 200 })])(
        'contains the median',
        samples => {
            const sorted = sortedCopy(samples);
            const interval = expectPresent(medianInterval(sorted));
            const { median } = summarize(samples);

            expect(interval[0]).toBeLessThanOrEqual(median);
            expect(interval[1]).toBeGreaterThanOrEqual(median);
        }
    );
});

describe('modes', () => {
    it.prop([
        fc.integer({ min: 3, max: 40 }),
        fc.integer({ min: 3, max: 40 }),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 1.1, max: 10, noNaN: true })
    ])('finds two clusters of rounds far apart', (fastCount, slowCount, fastTime, factor) => {
        const count = fastCount + slowCount;
        fc.pre(Math.min(fastCount, slowCount) >= Math.ceil(count * 0.1));

        const fast = evenly(fastCount, fastTime, fastTime * 1.005);
        const slow = evenly(slowCount, fastTime * factor, fastTime * factor * 1.005);
        const modes = expectPresent(modesOf(sortedCopy([...slow, ...fast])));

        expect(modes.fast.rounds).toBe(fastCount);
        expect(modes.slow.rounds).toBe(slowCount);
        expect(modes.fast.median).toBeGreaterThanOrEqual(fast[0]);
        expect(modes.fast.median).toBeLessThanOrEqual(fast[fast.length - 1]);
        expect(modes.slow.median).toBeGreaterThanOrEqual(slow[0]);
        expect(modes.slow.median).toBeLessThanOrEqual(slow[slow.length - 1]);
    });

    it.prop([
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.array(fc.double({ min: 1, max: 1.04, noNaN: true }), { maxLength: 200 })
    ])('finds none in rounds within 4% of each other', (time, factors) => {
        expect(modesOf(sortedCopy(factors.map(factor => time * factor)))).toBeNull();
    });

    it('finds none in fewer than 3 or 10% of the rounds', () => {
        const rounds = [...evenly(28, 100, 101), 200, 201, 202];
        expect(modesOf(sortedCopy(rounds))).toBeNull();
        expect(modesOf(sortedCopy([...evenly(29, 100, 101), 200, 201]))).toBeNull();
    });

    it('finds none in a normal spread or a long tail of slow rounds', () => {
        // The quantiles of a normal distribution of 5% deviation, and of a
        // distribution with a tail like that of load from other processes
        const normal = evenly(31, 0.01, 0.99).map(p => 100 * (1 + 0.05 * normalQuantile(p)));
        const tail = [...evenly(27, 100, 102), 110, 120, 130, 140];

        expect(modesOf(sortedCopy(normal))).toBeNull();
        expect(modesOf(sortedCopy(tail))).toBeNull();
    });
});

/** The standard normal distribution's quantile, by bisection of its CDF */
function normalQuantile(p: number): number {
    let low = -10;
    let high = 10;
    for (let i = 0; i < 100; i++) {
        const middle = (low + high) / 2;
        if (normalCdf(middle) < p) {
            low = middle;
        } else {
            high = middle;
        }
    }

    return (low + high) / 2;
}

/** The standard normal CDF, from Abramowitz and Stegun's 7.1.26 */
function normalCdf(x: number): number {
    const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
    const polynomial =
        t *
        (0.254829592 +
            t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - polynomial * Math.exp(-(x * x) / 2);

    return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
