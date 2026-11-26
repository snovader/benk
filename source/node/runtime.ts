// What benk needs from Node to time variants: timer loops that `new Function`
// compiles, V8's heap statistics, and Node's count of array buffers. Workers
// and browsers that forbid `new Function`, and runtimes without `node:v8`,
// need a runtime of their own.
import { cpus } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { getHeapStatistics, GCProfiler, type GCProfilerResult } from 'node:v8';
import { measureMemory } from 'node:vm';
import { asyncTimerSource, timerSource } from '#source/core/timer-source';
import type {
    ArrayBufferMeter,
    AsyncTimer,
    HeapMeter,
    Runtime,
    RuntimeDescription,
    Timer
} from '#source/core/types';

const TYPESCRIPT_SOURCE = 'benk from TypeScript source';

/**
 * Whether benk was loaded from its TypeScript source, rather than from its
 * bundle. In Node 26, stripping the types of a large enough TypeScript
 * file, as benk's own source is, grows a WebAssembly memory, which detaches
 * an ArrayBuffer. V8 14.6 then switches off its `ArrayBufferDetaching`
 * protector for the rest of the process, after which its optimized code
 * checks typed-array accesses for a detached buffer. That can slow code
 * that it compiled with a typed array as a constant: in one test, a sum of
 * a `Float64Array` of 1,000 numbers that a variant passed as a constant
 * took 4.28 µs rather than 1.41. V8 15.6 and 15.8 timed it alike either
 * way. So the runtime's process state records it, and a TypeScript entry
 * script, although it can't see whether other code detached a buffer.
 *
 * It reads the module's URL when a runtime is described rather than when
 * the module loads, since a bundle that another runtime loads may have none.
 */
function fromSource(): boolean {
    return import.meta.url.endsWith('.ts');
}

const TYPESCRIPT_ENTRY = 'entry script from TypeScript source';

/**
 * Whether the process's entry script is TypeScript, as a benchmark that
 * `node bench.ts` runs is, also with benk's bundle. Node strips its types
 * as it does those of benk's source, which detaches an ArrayBuffer when
 * the file is large enough. The modules that it imports aren't seen.
 */
function entryFromSource(): boolean {
    return /\.[cm]?ts$/.test(process.argv[1] ?? '');
}

type AsyncFunctionConstructor = new (...source: string[]) => AsyncTimer;

const AsyncFunction = async function () {
    // The constructor of async functions, which isn't a global
}.constructor as AsyncFunctionConstructor;

/**
 * The timer loops created in the process, which numbers each loop's source:
 * identical sources would share their compiled code and feedback through
 * V8's compilation cache
 */
let timers = 0;

/**
 * Times variants in Node: each in a timer loop of its own, compiled from a
 * unique source, and counts heap bytes with V8's heap statistics, and the
 * bytes of array buffers with Node's
 */
export class NodeRuntime implements Runtime {
    readonly heap: HeapMeter = {
        start: startCounting,
        release: collectProfilers
    };
    readonly arrayBuffers: ArrayBufferMeter = {
        settle,
        start: startCountingBuffers,
        release: collectProfilers
    };

    /** Node's version and flags, and what benk set in the process */
    get description(): RuntimeDescription {
        return describeNode();
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

/**
 * Starts counting the bytes allocated on V8's heap: how much the heap's used
 * size grows, and what garbage collections free meanwhile, which a
 * `GCProfiler` reports. V8 allocates the contents of an `ArrayBuffer` of more
 * than 64 bytes outside its heap, so they're left out.
 */
function startCounting(): () => number {
    const stopProfiler = startProfiler();
    const before = getHeapStatistics().used_heap_size;

    return () => {
        const after = getHeapStatistics().used_heap_size;
        return after - before + freedBytes(stopProfiler());
    };
}

/**
 * The milliseconds that a count of array buffers waits before each sample.
 * V8 frees the buffers of a collection on a background thread after it, and
 * Node's count of array buffers falls as it does, which makes a sample
 * uncountable. In Node 24, 26 and 27 on an Apple M2 Pro, of 10 counts each
 * of 12 calls that allocated nothing to 16 MiB in buffers, 32 of the 360
 * ran out of samples without a wait, all of calls of 1 KiB or 8 KiB, and
 * none with it.
 */
const SETTLE_TIME = 1;

function settle(): Promise<void> {
    return wait(SETTLE_TIME);
}

/**
 * Starts counting the bytes of array buffers that Node allocates, outside
 * V8's heap: what its count of array buffers' bytes grows by. A collection
 * frees buffers, which a `GCProfiler` can't add back, as `freedBytes()` does
 * heap bytes: V8 frees them after the collection, so its statistics of V8's
 * external memory don't change. They changed in 2 of 1,164 collections of
 * typed arrays in Node 24, 26 and 27. So the count is null if a collection
 * started, or if the count fell, as when V8 freed the buffers of an earlier
 * one meanwhile.
 */
function startCountingBuffers(): () => number | null {
    const stopProfiler = startProfiler();
    const before = process.memoryUsage().arrayBuffers;

    return () => {
        const after = process.memoryUsage().arrayBuffers;
        const statistics = stopProfiler();

        return statistics.length > 0 || after < before ? null : after - before;
    };
}

type GCStatistics = GCProfilerResult['statistics'];

/**
 * Whether a GC profiler that a count started saw a collection, since
 * `collectProfilers()` last ran a full one.
 *
 * `GCProfiler.stop()` returns a profiler's statistics, but leaves its
 * callbacks registered with V8 until the profiler itself is collected, in
 * Node 24, 26 and 27. In each collection until then, each of them reads V8's
 * statistics and appends them to its JSON. A profiler that saw no collection
 * is in V8's young generation, and the next scavenge collects it. One whose
 * sample saw two scavenges is in the old generation, which only a full
 * collection collects, and a sample of a call that allocates sees several.
 * So without a full collection, the next group's allocating calls collect
 * more slowly. On an Apple M2 Pro, after 100 such profilers, a call that
 * allocated 100 small objects took 2,600 to 3,000 ns rather than 330, in
 * Node 24.22.3, 26.13.0 and 27.0.0-alpha, and 250 after a full collection.
 * One profiler slowed it by 3 to 6%, 2 by 8 to 17%, and 5 by 24 to 32%, in 3
 * runs each in Node 26.13.0.
 *
 * Neither a profiler for all of a group's samples, nor V8's count of the
 * bytes allocated, can replace one for each sample. The first leaves one
 * profiler, and can't tell which sample a collection fell in. Node 26's
 * `total_allocated_bytes` counts each of V8's allocation areas whole when it
 * starts it, which made a call of 16 bytes count 18 to 2,875, and Node 24
 * hasn't got it.
 */
let profilersToCollect = false;

/**
 * Starts a GC profiler, and returns the function that stops it and returns
 * the statistics of each collection that it saw
 */
function startProfiler(): () => GCStatistics {
    const profiler = new GCProfiler();
    profiler.start();

    return () => {
        const { statistics } = profiler.stop();
        if (statistics.length > 0) {
            profilersToCollect = true;
        }

        return statistics;
    };
}

/** A collection already requested in this isolate, shared by its meters. */
let collecting: Promise<void> | undefined;

async function collectProfilers(): Promise<void> {
    // A sample may stop while a collection requested by another group runs.
    if (collecting) {
        return collecting.then(collectProfilers);
    }
    if (!profilersToCollect) {
        return;
    }

    profilersToCollect = false;
    collecting = collectGarbage();
    try {
        await collecting;
    } catch (error) {
        profilersToCollect = true;
        throw error;
    } finally {
        collecting = undefined;
    }
}

/** Collects this isolate's stopped profilers without changing V8's process-wide flags. */
async function collectGarbage(): Promise<void> {
    if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        return;
    }

    // Eager measurement starts a full collection in this isolate. An inspector
    // collection slowed later rounds in the four-group run in the README.
    await measureMemory({ execution: 'eager' });
}

function freedBytes(statistics: GCStatistics): number {
    let freed = 0;
    for (const { beforeGC, afterGC } of statistics) {
        freed +=
            beforeGC.heapStatistics.usedHeapSize -
            afterGC.heapStatistics.usedHeapSize;
    }

    return freed;
}

function describeNode(): RuntimeDescription {
    const nodeOptions = process.env.NODE_OPTIONS;

    return {
        name: 'Node',
        version: process.version,
        engine: `V8 ${process.versions.v8}`,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model.trim() ?? 'unknown',
        flags: [
            ...process.execArgv,
            ...(nodeOptions ? [`NODE_OPTIONS=${nodeOptions}`] : [])
        ],
        processState: [
            ...(fromSource() ? [TYPESCRIPT_SOURCE] : []),
            ...(entryFromSource() ? [TYPESCRIPT_ENTRY] : [])
        ]
    };
}
