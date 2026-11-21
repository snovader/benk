import type {
    AsyncTimer,
    AsyncVariant,
    HeapMeter,
    Role,
    Runtime,
    SyncVariant,
    Timer,
    Variant
} from './types.ts';

/** The calls at which calibration stops doubling them */
const CALIBRATION_CALLS = 1 << 20;

/** The time per call below which no time counts, in nanoseconds */
const LEAST_TIME = 1e-3;

interface SyncLoop {
    readonly async: false;
    readonly variant: SyncVariant;
    readonly timer: Timer;
}

interface AsyncLoop {
    readonly async: true;
    readonly variant: AsyncVariant;
    readonly timer: AsyncTimer;
}

/** Where a variant stands in its group */
export interface Placement {
    /** The name in the results, which an A/A copy's differs from its variant's */
    readonly name: string;
    readonly role: Role;
    readonly group: string;
}

/**
 * A variant as its group's measurement times it: with a timer loop of its
 * own, and the calls that a round repeats. A loop of a sync variant runs
 * without awaiting anything, so that interleaved sync variants run straight
 * after one another.
 */
export class TimedVariant {
    readonly #loop: SyncLoop | AsyncLoop;
    readonly #placement: Placement;
    #repetitions = 1;

    constructor(variant: Variant, placement: Placement, runtime: Runtime) {
        this.#loop = variant.async
            ? { async: true, variant, timer: runtime.createAsyncTimer() }
            : { async: false, variant, timer: runtime.createTimer() };
        this.#placement = placement;
    }

    name(): string {
        return this.#placement.name;
    }

    role(): Role {
        return this.#placement.role;
    }

    isAsync(): boolean {
        return this.#loop.async;
    }

    /** The calls in each round */
    repetitions(): number {
        return this.#repetitions;
    }

    /** Times one round's calls, and returns the time per call in nanoseconds */
    time(): number | Promise<number> {
        const repetitions = this.#repetitions;
        const elapsed = this.#run(repetitions, undefined);

        return typeof elapsed === 'number'
            ? perCall(elapsed, repetitions)
            : elapsed.then(time => perCall(time, repetitions));
    }

    /**
     * The bytes that `repetitions` calls allocate on the heap, setup and
     * teardown aside, with the loop's own
     */
    allocated(meter: HeapMeter, repetitions: number): number | Promise<number> {
        return this.#run(repetitions, meter);
    }

    /**
     * Counts the calls that make a round take about `sampleTime`
     * milliseconds from the variant's first calls, doubling them until they
     * take a quarter of it. `clockReads` is whether the runtime's clock read
     * time for empty calls, when its resolution was estimated.
     *
     * @throws {TypeError} If a sync variant's call returns a promise, which
     * the sync loop wouldn't await.
     * @throws {Error} If the clock read no time for empty calls, and reads
     * none in a loop of `CALIBRATION_CALLS` of the variant's calls either,
     * as a clock that doesn't advance. No count of calls follows from that.
     */
    async calibrate(sampleTime: number, clockReads: boolean): Promise<void> {
        this.#checkResult();
        const elapsed = await this.#double(sampleTime);

        if (elapsed === 0 && !clockReads) {
            throw new Error(
                `Expected the runtime's clock to advance, but it read no time for empty calls, nor for ${CALIBRATION_CALLS.toLocaleString('en-US')} calls of ${this.#label()}`
            );
        }
    }

    /**
     * Counts the calls again after the warm-up rounds, from the fastest of
     * their times per call in nanoseconds, since the code that V8 optimized
     * meanwhile runs several times as fast as the first calls.
     *
     * A round shorter than a tick of the runtime's clock reads as no time,
     * as 3 calls of 20 ns do on a clock of 100 ns ticks. No count of calls
     * follows from that, so the calls are doubled again instead, now that
     * they're warm.
     */
    async recalibrate(fastest: number, sampleTime: number): Promise<void> {
        if (fastest > 0) {
            this.#fit(fastest, sampleTime);
        } else {
            await this.#double(sampleTime);
        }
    }

    /**
     * Doubles the calls of a loop until they take a quarter of `sampleTime`,
     * and counts a round's calls from their time. Returns the time of the
     * last loop in milliseconds, which is 0 if no loop read time.
     */
    async #double(sampleTime: number): Promise<number> {
        for (let repetitions = 1; ; repetitions *= 2) {
            const elapsed = await this.#run(repetitions, undefined);

            if (elapsed >= sampleTime / 4 || repetitions >= CALIBRATION_CALLS) {
                this.#fit(perCall(elapsed, repetitions), sampleTime);
                return elapsed;
            }
        }
    }

    /**
     * Counts the calls that make a round take about `sampleTime`
     * milliseconds, from a call's time in nanoseconds
     */
    #fit(nanoseconds: number, sampleTime: number): void {
        this.#repetitions = Math.max(
            1,
            Math.round((sampleTime * 1e6) / Math.max(nanoseconds, LEAST_TIME))
        );
    }

    /**
     * Runs a loop of `repetitions` calls between the variant's setup and
     * teardown, and returns its time in milliseconds, or the bytes that it
     * allocated when given a meter
     */
    #run(
        repetitions: number,
        meter: HeapMeter | undefined
    ): number | Promise<number> {
        const loop = this.#loop;
        if (loop.async) {
            return this.#runAsync(loop, repetitions, meter).catch(
                (error: unknown) => this.#fail(error)
            );
        }

        try {
            loop.variant.setup?.(repetitions);
            const stop = meter?.start();
            const elapsed = loop.timer(loop.variant.run, repetitions);
            const result = stop === undefined ? elapsed : stop();
            loop.variant.teardown?.();

            return result;
        } catch (error) {
            return this.#fail(error);
        }
    }

    async #runAsync(
        { variant, timer }: AsyncLoop,
        repetitions: number,
        meter: HeapMeter | undefined
    ): Promise<number> {
        await variant.setup?.(repetitions);
        const stop = meter?.start();
        const elapsed = await timer(variant.run, repetitions);
        const result = stop === undefined ? elapsed : stop();
        await variant.teardown?.();

        return result;
    }

    /**
     * Calls a sync variant once, apart from its timer loop, to check that it
     * doesn't return a promise, as an async function does when its variant
     * isn't marked `async`. It calls `run` as the loop does, as a function
     * of its own, so that one that reads `this` fails here as it would there.
     */
    #checkResult(): void {
        const loop = this.#loop;
        if (loop.async) {
            return;
        }

        let result: unknown;
        try {
            const { run } = loop.variant;
            loop.variant.setup?.(1);
            result = run();
            loop.variant.teardown?.();
        } catch (error) {
            this.#fail(error);
        }

        if (isThenable(result)) {
            // Without a handler, its rejection would be unhandled
            void Promise.resolve(result).catch(() => undefined);
            throw new TypeError(
                `${this.#label()} returned a promise, which a sync variant's loop wouldn't await. Mark the variant \`async: true\`.`
            );
        }
    }

    #fail(error: unknown): never {
        throw new Error(`${this.#label()} threw`, { cause: error });
    }

    #label(): string {
        const { group, name } = this.#placement;
        return `Variant "${name}" of group "${group}"`;
    }
}

function perCall(milliseconds: number, repetitions: number): number {
    return (milliseconds * 1e6) / repetitions;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        'then' in value &&
        typeof value.then === 'function'
    );
}
