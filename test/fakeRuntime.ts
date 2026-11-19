// A runtime whose clock moves only when a fake call spends time, and whose
// heap grows only when a fake call allocates, so that tests can check what a
// measurement makes of known times and allocations
import type {
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

    /** The time in milliseconds, as `performance.now()` gives it */
    now(): number {
        return this.#nanoseconds / 1e6;
    }

    spend(nanoseconds: number): void {
        this.#nanoseconds += nanoseconds;
    }
}

export class FakeHeap implements HeapMeter {
    #allocated = 0;
    #samples = 0;
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
}

export interface FakeRuntimeOptions {
    /** Whether the runtime counts heap bytes. True by default. */
    readonly heap?: boolean;
    /** What each heap sample counts of its own. 1,000 bytes by default. */
    readonly heapOverhead?: number;
    /** What the heap samples count wrongly, in turn. None by default. */
    readonly heapErrors?: readonly number[];
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
    readonly clock = new FakeClock();
    readonly fakeHeap: FakeHeap;
    readonly heap: HeapMeter | undefined;
    /** The last result of the last loop */
    sink: unknown;

    constructor({
        heap = true,
        heapOverhead = 1000,
        heapErrors = [0]
    }: FakeRuntimeOptions = {}) {
        this.fakeHeap = new FakeHeap(heapOverhead, heapErrors);
        this.heap = heap ? this.fakeHeap : undefined;
    }

    createTimer(): Timer {
        return (run, repetitions) => {
            const start = this.clock.now();
            let result: unknown;
            for (let i = 0; i < repetitions; i++) {
                result = run();
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
                result = await run();
            }
            this.sink = result;

            return this.clock.now() - start;
        };
    }

    /** A variant whose calls each take `nanoseconds` and allocate `bytes` */
    variant(name: string, nanoseconds: number, bytes = 0): SyncVariant {
        return {
            name,
            run: () => {
                this.clock.spend(nanoseconds);
                this.fakeHeap.allocate(bytes);
            }
        };
    }

    /** An async variant whose calls each take `nanoseconds` */
    asyncVariant(name: string, nanoseconds: number, bytes = 0): AsyncVariant {
        return {
            name,
            async: true,
            run: () => {
                this.clock.spend(nanoseconds);
                this.fakeHeap.allocate(bytes);

                return Promise.resolve();
            }
        };
    }
}
