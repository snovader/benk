// A runtime whose clock moves only when a call spends time, and whose heap
// and array buffers grow only when a fake call allocates, so that tests can
// check what a measurement makes of known times and allocations. A call that spends no
// time of its own, as benk's empty calls that time the clock, takes
// `emptyCall` nanoseconds, as no call is free.
import type {
    ArrayBufferMeter,
    AsyncTimer,
    AsyncVariant,
    HeapMeter,
    Runtime,
    RuntimeDescription,
    SyncVariant,
    Timer
} from 'benk';

export class FakeClock {
    #nanoseconds = 0;
    readonly #tick: number;

    /**
     * `tick` is the nanoseconds between the times that the clock reads, as
     * a coarse clock's, or 0 for a clock that reads every nanosecond spent
     */
    constructor(tick = 0) {
        this.#tick = tick;
    }

    /** The time in milliseconds, as `performance.now()` gives it */
    now(): number {
        const read =
            this.#tick > 0
                ? Math.floor(this.#nanoseconds / this.#tick) * this.#tick
                : this.#nanoseconds;

        return read / 1e6;
    }

    spend(nanoseconds: number): void {
        this.#nanoseconds += nanoseconds;
    }

    /** The nanoseconds spent, which the clock reads to its tick */
    spent(): number {
        return this.#nanoseconds;
    }
}

export class FakeHeap implements HeapMeter {
    #allocated = 0;
    #samples = 0;
    #releases = 0;
    readonly #overhead: number;
    readonly #errors: readonly number[];

    /**
     * `overhead` is what each sample counts of its own, and `errors` what
     * the samples count wrongly, in turn
     */
    constructor(overhead: number, errors: readonly number[]) {
        this.#overhead = overhead;
        this.#errors = errors;
    }

    allocate(bytes: number): void {
        this.#allocated += bytes;
    }

    start(): () => number {
        const before = this.#allocated;
        const error = this.#errors[this.#samples++ % this.#errors.length];

        return () => this.#allocated - before + this.#overhead + error;
    }

    release(): void {
        this.#releases++;
    }

    /** How many times the core released the meter */
    releases(): number {
        return this.#releases;
    }
}

export class FakeArrayBuffers implements ArrayBufferMeter {
    #allocated = 0;
    #samples = 0;
    #releases = 0;
    readonly #collectedAbove: number;
    readonly #freed: readonly number[];

    /**
     * `collectedAbove` is the most bytes that a sample allocates without a
     * garbage collection, which the meter can't count, and `freed` what the
     * background frees during the samples, in turn
     */
    constructor(collectedAbove: number, freed: readonly number[]) {
        this.#collectedAbove = collectedAbove;
        this.#freed = freed;
    }

    allocate(bytes: number): void {
        this.#allocated += bytes;
    }

    settle(): Promise<void> {
        return Promise.resolve();
    }

    start(): () => number | null {
        const before = this.#allocated;
        const freed = this.#freed[this.#samples++ % this.#freed.length];

        return () => {
            const allocated = this.#allocated - before;
            const counted = allocated - freed;

            return allocated > this.#collectedAbove || counted < 0
                ? null
                : counted;
        };
    }

    release(): void {
        this.#releases++;
    }

    /** How many times the core released the meter */
    releases(): number {
        return this.#releases;
    }
}

export interface FakeRuntimeOptions {
    /** Whether the runtime counts heap bytes. True by default. */
    readonly heap?: boolean;
    /** What each heap sample counts of its own. 1,000 bytes by default. */
    readonly heapOverhead?: number;
    /** What the heap samples count wrongly, in turn. None by default. */
    readonly heapErrors?: readonly number[];
    /** Whether the runtime counts array buffers' bytes. True by default. */
    readonly arrayBuffers?: boolean;
    /**
     * The most bytes of array buffers that a sample allocates without a
     * garbage collection. No limit by default.
     */
    readonly bufferCollectedAbove?: number;
    /**
     * The bytes of array buffers that the background frees during the
     * samples, in turn. None by default.
     */
    readonly bufferFrees?: readonly number[];
    /** The nanoseconds between the times that the clock reads. 0 by default. */
    readonly clockTick?: number;
    /**
     * The nanoseconds that a call takes when it spends none of its own, as
     * benk's empty calls that time the clock. 1 by default. With 0, the
     * clock moves only when a fake call spends time.
     */
    readonly emptyCall?: number;
    /**
     * The nanoseconds that the runtime's first loops each spend before
     * their calls, in turn, as cold code does. None by default.
     */
    readonly coldLoops?: readonly number[];
}

export class FakeRuntime implements Runtime {
    readonly description: RuntimeDescription = {
        name: 'Fake',
        version: '1.0.0',
        engine: 'none',
        platform: 'test',
        arch: 'none',
        cpu: 'none',
        flags: [],
        processState: []
    };
    readonly clock: FakeClock;
    readonly fakeHeap: FakeHeap;
    readonly heap: HeapMeter | undefined;
    readonly fakeArrayBuffers: FakeArrayBuffers;
    readonly arrayBuffers: ArrayBufferMeter | undefined;
    /** The last result of the last loop */
    sink: unknown;
    readonly #emptyCall: number;
    readonly #coldLoops: readonly number[];
    #loops = 0;

    constructor({
        heap = true,
        heapOverhead = 1000,
        heapErrors = [0],
        arrayBuffers = true,
        bufferCollectedAbove = Infinity,
        bufferFrees = [0],
        clockTick = 0,
        emptyCall = 1,
        coldLoops = []
    }: FakeRuntimeOptions = {}) {
        this.clock = new FakeClock(clockTick);
        this.fakeHeap = new FakeHeap(heapOverhead, heapErrors);
        this.heap = heap ? this.fakeHeap : undefined;
        this.fakeArrayBuffers = new FakeArrayBuffers(
            bufferCollectedAbove,
            bufferFrees
        );
        this.arrayBuffers = arrayBuffers ? this.fakeArrayBuffers : undefined;
        this.#emptyCall = emptyCall;
        this.#coldLoops = coldLoops;
    }

    createTimer(): Timer {
        return (run, repetitions) => {
            const start = this.clock.now();
            this.clock.spend(this.#coldLoops[this.#loops++] ?? 0);
            let result: unknown;
            for (let i = 0; i < repetitions; i++) {
                const before = this.clock.spent();
                result = run();
                this.#spendIfEmpty(before);
            }
            this.sink = result;

            return this.clock.now() - start;
        };
    }

    createAsyncTimer(): AsyncTimer {
        return async (run, repetitions) => {
            const start = this.clock.now();
            let result: unknown;
            for (let i = 0; i < repetitions; i++) {
                const before = this.clock.spent();
                result = await run();
                this.#spendIfEmpty(before);
            }
            this.sink = result;

            return this.clock.now() - start;
        };
    }

    /** Spends an empty call's time for a call that spent none since `before` */
    #spendIfEmpty(before: number): void {
        if (this.clock.spent() === before) {
            this.clock.spend(this.#emptyCall);
        }
    }

    /**
     * A variant whose calls each take `nanoseconds`, and allocate `bytes` on
     * the heap and `bufferBytes` in array buffers
     */
    variant(
        name: string,
        nanoseconds: number,
        bytes = 0,
        bufferBytes = 0
    ): SyncVariant {
        return {
            name,
            run: () => {
                this.clock.spend(nanoseconds);
                this.fakeHeap.allocate(bytes);
                this.fakeArrayBuffers.allocate(bufferBytes);
            }
        };
    }

    /** An async variant whose calls each take `nanoseconds`, as `variant()`'s */
    asyncVariant(
        name: string,
        nanoseconds: number,
        bytes = 0,
        bufferBytes = 0
    ): AsyncVariant {
        return {
            name,
            async: true,
            run: () => {
                this.clock.spend(nanoseconds);
                this.fakeHeap.allocate(bytes);
                this.fakeArrayBuffers.allocate(bufferBytes);

                return Promise.resolve();
            }
        };
    }
}
