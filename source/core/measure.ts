import { arrayBufferBytesPerCall } from './array-buffers.ts';
import { timerResolutionOf } from './clock.ts';
import { heapCounterOf } from './heap.ts';
import { chooseLead } from './lead.ts';
import { rotation } from './rotation.ts';
import {
    medianInterval,
    pairedRatios,
    quantile,
    summarize
} from './statistics.ts';
import { TimedVariant } from './timed-variant.ts';
import type {
    Group,
    GroupResult,
    Lead,
    Role,
    RunResult,
    Runtime,
    Summary,
    Variant,
    VariantResult
} from './types.ts';

/** How a group's variants are timed */
export interface MeasureOptions {
    /**
     * The timed rounds, at least: a run times whole rotations of the
     * variants' order, so that each takes each position equally often. 31 by
     * default.
     */
    readonly rounds?: number;
    /**
     * The rounds before them, which aren't counted, and after which the
     * calls in a round are counted again. 10 by default.
     */
    readonly warmupRounds?: number;
    /** The time of one variant's round, in milliseconds. 1 by default. */
    readonly sampleTime?: number;
    /**
     * Whether to add a copy of each group's first variant, whose ratio to
     * the first shows the run's noise. True by default.
     */
    readonly aa?: boolean;
    /**
     * Whether to count the bytes that calls allocate, on the heap and in
     * array buffers. True by default.
     */
    readonly heap?: boolean;
}

/** How a run selects and times groups */
export interface RunOptions extends MeasureOptions {
    /** Selects the groups whose name matches. All of them by default. */
    readonly filter?: RegExp;
    /** Called with each group's results, as soon as it's measured */
    readonly onGroup?: (result: GroupResult) => void;
    /**
     * Called with each group before its first timed round, after its
     * calibration and warm-up rounds, with `'timed'`, and after its last
     * timed round, before its bytes are counted, with `'done'`. Something
     * that the caller does then, such as starting a profiler, takes the time
     * of the rounds that it falls between.
     */
    readonly onRounds?: (group: Group, rounds: TimedRounds) => void;
}

/** Where a group's timed rounds are: about to start, or done */
export type TimedRounds = 'timed' | 'done';

export const DEFAULT_OPTIONS: Required<MeasureOptions> = {
    rounds: 31,
    warmupRounds: 10,
    sampleTime: 1,
    aa: true,
    heap: true
};

/** What a group's measurement has of each variant before it's compared */
interface Measured {
    readonly variant: TimedVariant;
    readonly samples: Float64Array;
    readonly positions: Int32Array;
    readonly summary: Summary;
    readonly heapBytes: number | null;
    readonly arrayBufferBytes: number | null;
}

/**
 * Measures groups whose names match the filter, one after another, and
 * returns the run's results
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If a group has no variants, or two of the same name.
 * @throws {Error} If the runtime's clock reads no time, or if a variant
 * throws, with its error as the cause.
 */
export async function measureGroups(
    groups: Iterable<Group>,
    options: RunOptions,
    runtime: Runtime
): Promise<RunResult> {
    const resolved = resolveOptions(options);
    const date = new Date().toISOString();
    // A global or sticky expression's `test()` would move its `lastIndex`
    const filter = new RegExp(
        options.filter?.source ?? '',
        options.filter?.flags.replaceAll(/[gy]/g, '')
    );

    const results: GroupResult[] = [];
    for (const group of groups) {
        if (filter.test(group.name)) {
            const result = await measureGroup(
                group,
                resolved,
                runtime,
                options.onRounds
            );
            options.onGroup?.(result);
            results.push(result);
        }
    }

    return {
        schema: 4,
        date,
        runtime: runtime.description,
        options: { ...resolved, filter: options.filter?.source ?? '' },
        groups: results,
        v8Report: null
    };
}

/**
 * Measures a group's variants: times them interleaved, in rounds that each
 * run every variant once, in an order that rotates so that each variant
 * takes each position equally often, as `rotation()` describes. Load from
 * other processes then slows every variant alike, and only for some rounds.
 * Each variant gets its own timer loop, so that its call site and type
 * feedback aren't shared with the others.
 *
 * Before the variants' first calls, it estimates the resolution of the
 * runtime's timer loops, once for each runtime, which the group's results
 * record: a round of few times the resolution reads its time coarsely,
 * which `formatGroup()` notes. It takes the timer loop for that before the
 * variants' loops, so that a runtime with too few loops fails on it first.
 *
 * A round of a variant repeats its call for about `sampleTime`. The
 * repetitions are counted from the variant's first calls, and then again from
 * its fastest warm-up round, since the code that V8 optimizes during the
 * warm-up runs several times as fast as the first calls.
 *
 * Then it counts the bytes that each variant's calls allocate on the heap,
 * and in array buffers outside it, with the same timer loops, in samples
 * apart from the timed rounds, and compares each variant with the first, as
 * `VariantResult` describes. After the counts, the meters release what they
 * left in the process, as `HeapMeter.release()` describes, so that the time
 * of what runs next doesn't depend on them.
 *
 * It calls `onRounds` before the first timed round and after the last, as
 * `RunOptions` describes.
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If the group has no variants, or two of the same name.
 * @throws {Error} If the runtime's clock reads no time, or if a variant
 * throws, with its error as the cause.
 */
export async function measureGroup(
    group: Group,
    measureOptions: MeasureOptions,
    runtime: Runtime,
    onRounds?: RunOptions['onRounds']
): Promise<GroupResult> {
    const options = resolveOptions(measureOptions);
    const { sampleTime, warmupRounds } = options;
    const timerResolution = timerResolutionOf(runtime);
    const variants = timedVariants(group, options.aa, runtime);
    const orders = rotation(variants.length);
    const rounds = Math.ceil(options.rounds / orders.length) * orders.length;

    for (const variant of variants) {
        await variant.calibrate(sampleTime, timerResolution !== null);
    }
    if (warmupRounds > 0) {
        const warm = await timeRounds(variants, orders, warmupRounds);
        for (const [i, variant] of variants.entries()) {
            await variant.recalibrate(Math.min(...warm.samples[i]), sampleTime);
        }
    }

    onRounds?.(group, 'timed');
    const { samples, positions } = await timeRounds(variants, orders, rounds);
    onRounds?.(group, 'done');

    const heap = options.heap ? heapCounterOf(runtime) : undefined;
    const arrayBuffers = options.heap ? runtime.arrayBuffers : undefined;

    const measured: Measured[] = [];
    const errors: unknown[] = [];
    try {
        for (const [i, variant] of variants.entries()) {
            measured.push({
                variant,
                samples: samples[i],
                positions: positions[i],
                summary: summarize(samples[i]),
                heapBytes: (await heap?.bytesPerCall(variant)) ?? null,
                arrayBufferBytes: arrayBuffers
                    ? await arrayBufferBytesPerCall(arrayBuffers, variant)
                    : null
            });
        }
    } catch (error) {
        errors.push(error);
    }

    // Release the meters that actually took the samples, even if a count or
    // another release failed. A runtime can provide its meters via getters.
    for (const meter of [heap, arrayBuffers]) {
        if (meter == null) {
            continue;
        }
        try {
            await meter.release?.();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 1) {
        throw errors[0];
    }
    if (errors.length > 1) {
        throw new AggregateError(
            errors,
            `Multiple errors counting bytes of group "${group.name}"`,
            {
                cause: errors[0]
            }
        );
    }

    const { lead, reason } = chooseLead(group.lead ?? 'auto', measured);

    return {
        name: group.name,
        lead,
        leadReason: reason,
        rounds,
        timerResolution,
        variants: measured.map(variant =>
            variantResult(variant, measured[0], lead)
        )
    };
}

/**
 * The group's variants with their timer loops: the reference first, then the
 * others, and then the A/A copy of the reference, if the group or else the
 * run asks for one
 */
function timedVariants(
    group: Group,
    aa: boolean,
    runtime: Runtime
): TimedVariant[] {
    const [reference] = group.variants;
    if (reference == null) {
        throw new TypeError(`Expected group "${group.name}" to have variants`);
    }

    const placed: Array<[Variant, string, Role]> = group.variants.map(
        (variant, i) => [
            variant,
            variant.name,
            i === 0 ? 'reference' : 'variant'
        ]
    );
    if (group.aa ?? aa) {
        placed.push([reference, `${reference.name} A/A`, 'aa']);
    }

    const names = new Set<string>();
    return placed.map(([variant, name, role]) => {
        if (names.has(name)) {
            throw new TypeError(
                `Expected the variants of group "${group.name}" to have different names, but "${name}" repeats`
            );
        }
        names.add(name);

        return new TimedVariant(
            variant,
            { name, role, group: group.name },
            runtime
        );
    });
}

interface Rounds {
    /** Each variant's time per call in each round, in nanoseconds */
    readonly samples: Float64Array[];
    /** Each variant's position in each round */
    readonly positions: Int32Array[];
}

/**
 * Times `rounds` rounds of the variants, each once a round, in the orders of
 * a rotation, one after another
 */
async function timeRounds(
    variants: readonly TimedVariant[],
    orders: readonly number[][],
    rounds: number
): Promise<Rounds> {
    const samples = variants.map(() => new Float64Array(rounds));
    const positions = variants.map(() => new Int32Array(rounds));

    for (let round = 0; round < rounds; round++) {
        const order = orders[round % orders.length];
        for (const [position, i] of order.entries()) {
            // Awaits only an async variant's time, so that sync variants run
            // straight after one another
            const time = variants[i].time();
            samples[i][round] = typeof time === 'number' ? time : await time;
            positions[i][round] = position;
        }
    }

    return { samples, positions };
}

/** A variant's results, with its ratio to the reference by the lead */
function variantResult(
    {
        variant,
        samples,
        positions,
        summary,
        heapBytes,
        arrayBufferBytes
    }: Measured,
    reference: Measured,
    lead: Lead
): VariantResult {
    const role = variant.role();
    const ratios = pairedRatios(samples, reference.samples);
    ratios.sort();

    const ratio =
        lead === 'fastest'
            ? summary.fastest / reference.summary.fastest
            : quantile(ratios, 0.5);

    return {
        name: variant.name(),
        role,
        async: variant.isAsync(),
        repetitions: variant.repetitions(),
        samples: Array.from(samples),
        positions: Array.from(positions),
        summary,
        ratio: role === 'reference' ? 1 : ratio,
        interval: role === 'reference' ? null : medianInterval(ratios),
        heapBytes,
        arrayBufferBytes,
        v8: null
    };
}

/**
 * The options with their defaults
 *
 * @throws {RangeError} If an option is out of its range.
 */
export function resolveOptions(
    options: MeasureOptions
): Required<MeasureOptions> {
    const resolved: Required<MeasureOptions> = {
        rounds: options.rounds ?? DEFAULT_OPTIONS.rounds,
        warmupRounds: options.warmupRounds ?? DEFAULT_OPTIONS.warmupRounds,
        sampleTime: options.sampleTime ?? DEFAULT_OPTIONS.sampleTime,
        aa: options.aa ?? DEFAULT_OPTIONS.aa,
        heap: options.heap ?? DEFAULT_OPTIONS.heap
    };

    if (!Number.isInteger(resolved.rounds) || resolved.rounds < 1) {
        throw new RangeError(
            `Expected rounds to be a positive integer, got ${resolved.rounds}`
        );
    }
    if (!Number.isInteger(resolved.warmupRounds) || resolved.warmupRounds < 0) {
        throw new RangeError(
            `Expected warm-up rounds to be an integer of at least 0, got ${resolved.warmupRounds}`
        );
    }
    if (!(resolved.sampleTime > 0 && resolved.sampleTime < Infinity)) {
        throw new RangeError(
            `Expected the sample time to be a positive number of milliseconds, got ${resolved.sampleTime}`
        );
    }

    return resolved;
}
