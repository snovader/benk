// What benk needs from d8, the V8 shell, to time variants: timer loops that
// `new Function` compiles, as Node's are, what d8 knows of itself from the
// globals that it adds, and, with three of its flags, the bytes of array
// buffers. d8 has no `node:v8`, and nothing that adds back the heap bytes
// that a collection frees, so the runtime counts no heap bytes.
import { asyncTimerSource, timerSource } from '#source/core/timer-source';
import type {
    ArrayBufferMeter,
    AsyncTimer,
    Runtime,
    RuntimeDescription,
    Timer
} from '#source/core/types';

// The globals of d8 that the runtime reads, which aren't in any of
// TypeScript's libraries

/** V8's version, such as `'15.8.62.9'` */
declare function version(): string;

declare const os: {
    /** The operating system that d8 was built for, such as `'macos'` */
    readonly name: string;
};

declare const d8: {
    readonly serializer: {
        /** Writes a value as V8's `ValueSerializer` does, for `postMessage` */
        serialize(value: unknown): ArrayBuffer;
    };
};

/** The tag that V8's serializer writes a small integer with, as an int32 */
const INT32_TAG = 'I'.charCodeAt(0);

/**
 * The bits of V8's small integers, the integers that it keeps in place of a
 * pointer rather than as numbers on its heap. With pointer compression they
 * have 31 bits, as in Homebrew's d8 15.8, so integers from 2³⁰ to 2³¹ - 1
 * are heap numbers. In Node 26 they have 32.
 *
 * d8 has no property that says which. Its serializer writes a small integer
 * with an int32's tag, and a heap number with a double's, so 2³⁰ gets the
 * first with 32 bits, and the second with 31. That reads how V8 holds the
 * number, without `--allow-natives-syntax`'s `%IsSmi()`.
 */
function smallIntegerBits(): 31 | 32 {
    const bytes = new Uint8Array(d8.serializer.serialize(2 ** 30));

    // The header is the version's tag, 0xFF, and the format's version, as a
    // varint, whose bytes but the last have their high bit set
    let at = 1;
    while (bytes[at] >= 0x80) {
        at++;
    }

    return bytes[at + 1] === INT32_TAG ? 32 : 31;
}

type AsyncFunctionConstructor = new (...source: string[]) => AsyncTimer;

const AsyncFunction = async function () {
    // The constructor of async functions, which isn't a global
}.constructor as AsyncFunctionConstructor;

/**
 * The timer loops created in the process, which numbers each loop's source:
 * identical sources would share their compiled code and feedback through
 * V8's compilation cache. Node's runtime numbers its own, which d8 doesn't
 * load.
 */
let timers = 0;

/**
 * Times variants in d8, the V8 shell: each in a timer loop of its own,
 * compiled from a unique source, as `NodeRuntime` does. It counts no heap
 * bytes, which d8 has no API for. It counts the bytes of array buffers
 * where d8 started with `--expose-statistics`, `--expose-gc` and
 * `--allow-natives-syntax`, which it checks when it's created, and none
 * otherwise. Its description reads d8's globals, so it describes only a
 * run in d8.
 */
export class D8Runtime implements Runtime {
    readonly heap = undefined;
    readonly arrayBuffers: ArrayBufferMeter | undefined;

    constructor() {
        const collector = collectorOfShell();
        this.arrayBuffers =
            collector &&
            ({
                settle: settled,
                start: () => startCountingBuffers(collector)
            } satisfies ArrayBufferMeter);
    }

    /**
     * d8's version, its platform, and the bits of V8's small integers, and
     * the flags that the count of array buffers needs, where it has them
     */
    get description(): RuntimeDescription {
        return describeD8(this.arrayBuffers != null);
    }

    createTimer(): Timer {
        // oxlint-disable-next-line typescript/no-implied-eval -- A timer loop of its own for each variant
        return new Function(
            'run',
            'repetitions',
            timerSource(timers++)
        ) as Timer;
    }

    createAsyncTimer(): AsyncTimer {
        return new AsyncFunction(
            'run',
            'repetitions',
            asyncTimerSource(timers++)
        );
    }
}

function describeD8(countsBuffers: boolean): RuntimeDescription {
    const v8 = version();

    return {
        name: 'd8',
        // d8's version is V8's
        version: v8,
        engine: `V8 ${v8}`,
        platform: os.name,
        // d8 knows neither, nor the flags that it started with, but for
        // those whose functions the count of array buffers found
        arch: 'unknown',
        cpu: 'unknown',
        flags: [...(countsBuffers ? BUFFER_FLAGS : []), 'unknown'],
        processState: [`${smallIntegerBits()}-bit small integers`]
    };
}

/** The flags of d8 that add the functions that a count of buffers needs */
const BUFFER_FLAGS = [
    '--allow-natives-syntax',
    '--expose-gc',
    '--expose-statistics'
];

/** What the runtime reads of the object that `getV8Statistics()` returns */
interface V8Statistics {
    /**
     * The bytes outside its heap that V8 keeps account of, among them the
     * contents of array buffers and WebAssembly's memories, but not those
     * of a `SharedArrayBuffer`. V8 adds a buffer's bytes when it allocates
     * them, and takes them off after a collection, when it has swept the
     * buffers that the collection found dead.
     */
    readonly amount_of_external_allocated_memory: number;
}

/** The functions of d8 that a count of array buffers needs */
interface Collector {
    /**
     * `getV8Statistics()`, which `--expose-statistics` adds. After it reads
     * the statistics, it walks the heap, which first finishes V8's sweeping
     * of array buffers.
     */
    readonly statistics: () => V8Statistics;
    /**
     * `gc()`, which `--expose-gc` adds: a full collection, or a scavenge of
     * the young generation with `{ type: 'minor' }`
     */
    readonly collect: (options?: { readonly type: 'minor' }) => void;
    /** `%InYoungGeneration()`, which `--allow-natives-syntax` parses */
    readonly isYoung: (value: object) => boolean;
}

const MINOR = { type: 'minor' } as const;

/**
 * d8's functions that a count of array buffers needs, or undefined where d8
 * started without one of the flags that add them, or its collections don't
 * move objects as the count needs
 */
function collectorOfShell(): Collector | undefined {
    const shell = globalThis as {
        readonly getV8Statistics?: unknown;
        readonly gc?: unknown;
    };
    const { getV8Statistics, gc } = shell;
    const isYoung = compileIsYoung();
    if (
        typeof getV8Statistics !== 'function' ||
        typeof gc !== 'function' ||
        isYoung == null
    ) {
        return undefined;
    }

    const collector = {
        statistics: getV8Statistics as Collector['statistics'],
        collect: gc as Collector['collect'],
        isYoung
    };
    const { amount_of_external_allocated_memory: external } =
        collector.statistics();

    return Number.isFinite(external) && movesSurvivors(collector)
        ? collector
        : undefined;
}

/**
 * `%InYoungGeneration()` of V8's natives, or undefined where d8 started
 * without `--allow-natives-syntax`, which a natives call needs to parse
 */
function compileIsYoung(): Collector['isYoung'] | undefined {
    try {
        // oxlint-disable-next-line typescript/no-implied-eval -- A natives call, which parses only with --allow-natives-syntax
        return new Function(
            'value',
            'return %InYoungGeneration(value)'
        ) as Collector['isYoung'];
    } catch {
        return undefined;
    }
}

/**
 * Whether V8 moves an object out of its young generation at each collection
 * once the object has survived a scavenge, which is how a count sees that a
 * collection happened. A scavenge keeps an object that it finds alive for
 * the first time in the young generation, and promotes it to the old at the
 * second, and a full collection promotes every young object that's alive.
 * With `--minor-ms`, V8 collects the young generation without moving its
 * objects, and a count couldn't see those collections.
 */
function movesSurvivors({ collect, isYoung }: Collector): boolean {
    const scavenged = {};
    collect(MINOR);
    const keptYoung = isYoung(scavenged);
    collect(MINOR);
    const promoted = !isYoung(scavenged);

    const collected = {};
    collect(MINOR);
    collect();
    return keptYoung && promoted && !isYoung(collected);
}

/**
 * A count of array buffers has nothing to wait for: `startCountingBuffers()`
 * finishes V8's sweeping of buffers itself, after the variant's setup, which
 * can collect too.
 */
function settled(): Promise<void> {
    return Promise.resolve();
}

/**
 * Starts counting the bytes of array buffers that V8 allocates outside its
 * heap: what its account of external bytes grows by. V8 takes the bytes of
 * the buffers that a collection found dead off that account after the
 * collection, when it next allocates a buffer and its sweeping of buffers
 * has finished. So a sample in which a collection happens can count too
 * few, or less than none. In d8 15.8.62.9 on an Apple M2 Pro, 83 of 100
 * samples of 100,000 calls that each allocated a 1 KiB `Uint8Array` counted
 * 353 bytes a call. d8 can't tell how many bytes V8 took off, as Node's
 * `GCProfiler` can't, so a count is null if a collection happened.
 *
 * A sentinel object shows whether one did. It survives a scavenge before
 * the sample, so that any collection during the sample moves it out of the
 * young generation, as `movesSurvivors()` checks. That scavenge also
 * empties the young generation, so that fewer samples start one. In the
 * same d8, of 4,254 samples of calls that allocated from nothing to 16 MiB
 * of buffers, V8's `--trace-gc` printed collections in 1,975, of which 157
 * had a mark-compact, and the sentinel had moved in each of them. The 2,016
 * samples that counted were each right. Two other signs of a collection
 * miss some: a `WeakRef` made before the sample, to an object that only it
 * held, missed 50 of 2,213 samples with collections, and V8's count of the
 * heap's bytes after the last collection, with `--map-counters`, missed 3,
 * where two collections left the same bytes. A sample that they miss can
 * count wrong, as 23 of the `WeakRef`'s 50 did.
 *
 * A count is null too if the account fell without a collection that the
 * sentinel saw, as when the variant detaches a buffer.
 */
function startCountingBuffers({
    statistics,
    collect,
    isYoung
}: Collector): () => number | null {
    const sentinel = {};
    collect(MINOR);

    // Each read walks the heap after it reads, which finishes the sweeping
    // of buffers that the scavenge found dead, so the second reads after it
    statistics();
    const before = statistics().amount_of_external_allocated_memory;
    const survived = isYoung(sentinel);

    return () => {
        const after = statistics().amount_of_external_allocated_memory;
        const collected = !survived || !isYoung(sentinel);

        return collected || after < before ? null : after - before;
    };
}
