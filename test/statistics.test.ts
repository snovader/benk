import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { medianInterval, summarize } from 'benk';
import {
    changeOf,
    changesOf,
    modesOf,
    positionEffectOf,
    sortedCopy
} from '#source/core/statistics';
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

/**
 * `count` rounds of `time`, up to 0.5% slower in an order that neither rises
 * nor falls, so that they change nowhere. The first and last take the middle
 * time, as an extreme round next to a change ranks as if on its other side.
 */
function steady(count: number, time: number): number[] {
    return Array.from({ length: count }, (_, i) => {
        const jitter = i === 0 || i === count - 1 ? 5 : (7 * i) % 11;
        return time * (1 + (0.005 * jitter) / 10);
    });
}

/** The rounds that each part of a change needs at least, as of the modes */
function least(count: number): number {
    return Math.max(3, Math.ceil(count * 0.1));
}

describe('changes', () => {
    it.prop([
        fc
            .integer({ min: 31, max: 120 })
            .chain(count =>
                fc.tuple(
                    fc.constant(count),
                    fc.integer({ min: least(count), max: count - least(count) })
                )
            ),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 1.1, max: 10, noNaN: true }),
        fc.boolean()
    ])(
        'finds where the rounds changed, and the median of each part',
        ([count, before], time, factor, faster) => {
            const afterTime = faster ? time / factor : time * factor;
            const first = steady(before, time);
            const rest = steady(count - before, afterTime);
            const change = expectPresent(changeOf(Float64Array.from([...first, ...rest])));

            expect(change.shape).toBe('step');
            expect(change.before.rounds).toBe(before);
            expect(change.after.rounds).toBe(count - before);
            expect(change.before.median).toBe(summarize(first).median);
            expect(change.after.median).toBe(summarize(rest).median);
        }
    );

    it.prop([
        fc.integer({ min: 31, max: 120 }),
        // From which the medians of the halves are 5% apart, or more
        fc.double({ min: 1.2, max: 3, noNaN: true }),
        fc.boolean()
    ])(
        'tells a steady drift from a step, with the medians of its first and last rounds',
        (count, factor, faster) => {
            const total = faster ? 1 / factor : factor;
            const rounds = steady(count, 100).map((time, i) => time * total ** (i / (count - 1)));
            const ends = least(count);
            const change = expectPresent(changeOf(Float64Array.from(rounds)));

            expect(change.shape).toBe('drift');
            expect([change.before.rounds, change.after.rounds]).toStrictEqual([ends, ends]);
            expect(change.before.median).toBe(summarize(rounds.slice(0, ends)).median);
            expect(change.after.median).toBe(summarize(rounds.slice(-ends)).median);
        }
    );

    it.prop([
        fc
            .integer({ min: 31, max: 120 })
            .chain(count =>
                fc.tuple(
                    fc.constant(count),
                    fc.integer({ min: least(count), max: Math.floor(count / 2) })
                )
            ),
        fc.double({ min: 1.2, max: 10, noNaN: true }),
        fc.double({ min: 0.02, max: 0.045, noNaN: true })
    ])(
        'finds a change in the first rounds of rounds that then drift by a few percent',
        ([count, before], factor, drift) => {
            // The later rounds get faster by `drift` in all, with jitter of
            // 0.5%, so that a split among them is far from its mean too
            const rest = steady(count - before, 100).map(
                (time, i) => time * (1 - (drift * i) / (count - before))
            );
            const rounds = [...steady(before, 100 * factor), ...rest];

            expect(changeOf(Float64Array.from(rounds))?.before.rounds).toBe(before);
        }
    );

    it.prop([
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.array(fc.double({ min: 1, max: 1.04, noNaN: true }), { minLength: 31, maxLength: 200 })
    ])('finds none in rounds within 4% of each other, even in order', (time, factors) => {
        factors.sort((a, b) => a - b);
        expect(changeOf(Float64Array.from(factors, factor => time * factor))).toBeNull();
    });

    it.prop([
        fc
            .integer({ min: 31, max: 120 })
            .chain(count =>
                fc.tuple(
                    fc.constant(count),
                    fc.integer({ min: least(count), max: count - least(count) })
                )
            ),
        fc.boolean()
    ])(
        'finds none where rounds like those before recur after it, as every 4th',
        ([count, before], faster) => {
            const [first, other] = faster ? [300, 100] : [100, 300];
            const rounds = Array.from({ length: count }, (_, i) =>
                i < before || (i - before) % 4 === 3 ? first : other
            );

            expect(changeOf(Float64Array.from(rounds))).toBeNull();
        }
    );

    it('finds none of fewer than 3 rounds or 10% of them', () => {
        const rounds = (before: number): Float64Array =>
            Float64Array.from([...steady(before, 200), ...steady(100 - before, 100)]);

        expect(changeOf(rounds(9))).toBeNull();
        expect(changeOf(rounds(10))?.before.rounds).toBe(10);
    });

    it.prop([
        fc.integer({ min: 8, max: 14 }),
        fc.double({ min: 1.2, max: 3, noNaN: true }),
        fc.uniqueArray(fc.integer({ min: 14, max: 35 }), { minLength: 2, maxLength: 2 }),
        // Beyond the steady rounds' jitter of 0.5%
        fc.double({ min: 1.02, max: 1.2, noNaN: true })
    ])(
        "finds a change in the reference and its A/A copy, as their run's own, past load spikes that every variant shares",
        (before, factor, spikes, above) => {
            // Two rounds after the change that load slowed in every variant, more
            // than the step, which breaks the order of the step's rounds in each
            // variant's own samples
            const timesOf = (base: number, stepped: boolean): Float64Array =>
                Float64Array.from(steady(36, base), (time, round) => {
                    const step = stepped && round < before ? factor : 1;
                    const load = spikes.includes(round) ? factor * above : 1;
                    return time * step * load;
                });
            const samples = [timesOf(100, true), timesOf(500, false), timesOf(100, true)];
            const { variants, shared } = changesOf(samples);

            // Its own samples alone miss the step, or misplace it
            expect(changeOf(samples[0])?.before.rounds).not.toBe(before);
            expect(variants.map(change => change?.before.rounds ?? null)).toStrictEqual([
                before,
                null,
                before
            ]);
            expect(shared).toBeNull();
        }
    );

    it('finds a change of every variant as theirs together, with the factor of each part', () => {
        const timesOf = (base: number): Float64Array =>
            Float64Array.from(steady(36, base), (time, round) => time * (round < 5 ? 1.5 : 1));

        const { variants, shared } = changesOf([timesOf(100), timesOf(500), timesOf(100)]);

        const change = expectPresent(shared);
        expect(variants).toStrictEqual([null, null, null]);
        expect(change.variants).toStrictEqual([0, 1, 2]);
        expect(change.shape).toBe('step');
        expect([change.before.rounds, change.after.rounds]).toStrictEqual([5, 31]);
        // Within the steady rounds' jitter of 0.5%
        expect(Math.abs(change.before.factor / change.after.factor / 1.5 - 1)).toBeLessThan(0.006);
    });

    it('finds none in 12 rounds or fewer, whose every order is too likely by chance', () => {
        const rounds = (count: number): Float64Array =>
            Float64Array.from([...steady(6, 1000), ...steady(count - 6, 100)]);

        expect(changeOf(rounds(8))).toBeNull();
        expect(changeOf(rounds(12))).toBeNull();
        expect(changeOf(rounds(13))?.before.rounds).toBe(6);
    });
});

/** The positions of rounds that take `count` positions in turn */
function cyclic(count: number, rounds: number): Int32Array {
    return Int32Array.from({ length: rounds }, (_, round) => round % count);
}

describe('position effects', () => {
    it('finds none where a sample is 0 or not a number, as a coarse clock or a failed read gives', () => {
        // The second of 3 positions at twice the time, which is an effect
        const positions = Int32Array.from({ length: 36 }, (_, round) => round % 3);
        const samples = Float64Array.from(positions, (position, round) =>
            position === 1 ? 200 + (round % 5) : 100 + (round % 5)
        );
        const withNaN = samples.slice();
        withNaN[7] = Number.NaN;
        // Rounds shorter than the clock's tick in the first position
        const coarse = Float64Array.from(positions, position => (position === 0 ? 0 : 42));

        expect(positionEffectOf(samples, positions)?.position).toBe(1);
        expect(positionEffectOf(withNaN, positions)).toBeNull();
        expect(positionEffectOf(coarse, positions)).toBeNull();
    });

    it('checks both thresholds when a different position ranks just as far from its mean', () => {
        const positions = cyclic(4, 32);
        const times = [100, 101, 102, 200];
        for (let position = 0; position < times.length; position++) {
            const samples = Float64Array.from(positions, p => times[(p + 3 - position) % 4]);
            expect(positionEffectOf(samples, positions)).toStrictEqual({
                position,
                median: 200,
                others: 101
            });
        }
    });

    it.prop([
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 6, max: 20 }),
        fc.nat(),
        fc.double({ min: 1.2, max: 5, noNaN: true }),
        fc.boolean()
    ])(
        'finds the position whose rounds took longer or shorter than the others',
        (count, perPosition, which, factor, slower) => {
            const rounds = count * perPosition;
            // A position whose rounds are all slower than the others' is this
            // far from its mean, which needs to reach 3.7
            const others = rounds - perPosition;
            fc.pre(Math.sqrt((3 * perPosition * others) / (rounds + 1)) >= 3.7);

            const position = which % count;
            const positions = cyclic(count, rounds);
            const time = slower ? 100 * factor : 100 / factor;
            const samples = steady(rounds, 100).map((sample, round) =>
                positions[round] === position ? (sample * time) / 100 : sample
            );
            const effect = expectPresent(positionEffectOf(Float64Array.from(samples), positions));
            // Of two positions, each differs from the other as much, and the
            // first is taken
            const [expected, median, other] =
                count === 2 && position === 1 ? [0, 100, time] : [position, time, 100];

            expect(effect.position).toBe(expected);
            expect(effect.median / median).toBeGreaterThanOrEqual(1);
            expect(effect.median / median).toBeLessThanOrEqual(1.005);
            expect(effect.others / other).toBeGreaterThanOrEqual(1);
            expect(effect.others / other).toBeLessThanOrEqual(1.005);
        }
    );

    it.prop([fc.integer({ min: 2, max: 6 }), fc.integer({ min: 6, max: 20 })])(
        "finds none where the positions' rounds differ by under 5%",
        (count, perPosition) => {
            const positions = cyclic(count, count * perPosition);
            const samples = Float64Array.from(
                positions,
                (position, round) => 100 * (1 + (0.04 * position) / (count - 1) + 1e-6 * round)
            );

            expect(positionEffectOf(samples, positions)).toBeNull();
        }
    );

    it.prop([
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 6, max: 20 }),
        fc.nat(),
        fc.double({ min: 1.06, max: 1.1, noNaN: true })
    ])(
        "finds none where a position's rounds are as spread as the others', if slower",
        (count, perPosition, which, factor) => {
            const position = which % count;
            const positions = cyclic(count, count * perPosition);
            // Each position's rounds spread evenly over a factor of 3
            const samples = Float64Array.from(positions, (at, round) => {
                const time = evenly(perPosition, 100, 300)[Math.floor(round / count)];
                return at === position ? time * factor : time;
            });

            expect(positionEffectOf(samples, positions)).toBeNull();
        }
    );
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
