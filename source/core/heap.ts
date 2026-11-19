import { quantile } from './statistics.ts';
import { TimedVariant } from './timedVariant.ts';
import type { HeapMeter, Runtime } from './types.ts';

/**
 * Samples of each variant's heap bytes, after its timed rounds. The fewest
 * count, since compiling and deoptimizing allocate too.
 */
const SAMPLES = 5;

/**
 * Samples of what a sample allocates itself, of which the median counts,
 * rather than the fewest: in a sample just after startup, the heap's used
 * size can shrink. In one process, one sample gave -22,896 bytes against 880
 * for the others, which added 77 bytes to each call of a getter that
 * allocates none.
 */
const BASELINE_SAMPLES = 20;

/**
 * Counts the bytes that a variant's calls allocate on a runtime's heap, with
 * the variant's own timer loop, less what a sample of an empty loop of the
 * same kind allocates itself
 */
export class HeapCounter {
    readonly #meter: HeapMeter;
    readonly #runtime: Runtime;
    #syncBaseline: Promise<number> | undefined;
    #asyncBaseline: Promise<number> | undefined;

    constructor(meter: HeapMeter, runtime: Runtime) {
        this.#meter = meter;
        this.#runtime = runtime;
    }

    /** The bytes that a call of the variant allocates, in a round's calls */
    async bytesPerCall(variant: TimedVariant): Promise<number> {
        const repetitions = variant.repetitions();
        const baseline = await this.#baseline(variant.isAsync());
        const fewest = Math.min(...(await this.#samples(variant, repetitions)));

        return (fewest - baseline) / repetitions;
    }

    #baseline(async: boolean): Promise<number> {
        if (async) {
            this.#asyncBaseline ??= this.#measureBaseline(
                new TimedVariant(
                    {
                        name: 'empty',
                        async: true,
                        run: () => Promise.resolve()
                    },
                    { name: 'empty', role: 'variant', group: 'baseline' },
                    this.#runtime
                )
            );
            return this.#asyncBaseline;
        }

        this.#syncBaseline ??= this.#measureBaseline(
            new TimedVariant(
                { name: 'empty', run: () => undefined },
                { name: 'empty', role: 'variant', group: 'baseline' },
                this.#runtime
            )
        );
        return this.#syncBaseline;
    }

    /** What a sample of a loop of no calls allocates: its median sample */
    async #measureBaseline(empty: TimedVariant): Promise<number> {
        const samples = await this.#samples(empty, 0, BASELINE_SAMPLES);
        samples.sort();

        return quantile(samples, 0.5);
    }

    async #samples(
        variant: TimedVariant,
        repetitions: number,
        count = SAMPLES
    ): Promise<Float64Array> {
        const bytes = new Float64Array(count);
        for (let sample = 0; sample < count; sample++) {
            bytes[sample] = await variant.allocated(this.#meter, repetitions);
        }

        return bytes;
    }
}

const counters = new WeakMap<Runtime, HeapCounter>();

/**
 * The heap counter of a runtime, which keeps its baselines between groups,
 * or undefined where the runtime can't count heap bytes
 */
export function heapCounterOf(runtime: Runtime): HeapCounter | undefined {
    const { heap } = runtime;
    if (heap === undefined) {
        return undefined;
    }

    let counter = counters.get(runtime);
    if (counter === undefined) {
        counter = new HeapCounter(heap, runtime);
        counters.set(runtime, counter);
    }

    return counter;
}
