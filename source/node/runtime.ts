// What benk needs from Node to time variants: timer loops that `new Function`
// compiles, and V8's heap statistics. Workers and browsers that forbid
// `new Function`, and runtimes without `node:v8`, need a runtime of their own.
import { cpus } from 'node:os';
import { GCProfiler, getHeapStatistics, type GCProfilerResult } from 'node:v8';
import type {
    AsyncTimer,
    HeapMeter,
    Runtime,
    RuntimeDescription,
    Timer
} from '#source/core/types';

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
 * unique source, and counts heap bytes with V8's heap statistics
 */
export class NodeRuntime implements Runtime {
    readonly description: RuntimeDescription = describeNode();
    readonly heap: HeapMeter = { start: startCounting };

    createTimer(): Timer {
        // oxlint-disable-next-line typescript/no-implied-eval -- A timer loop of its own for each variant
        return new Function(
            'run',
            'repetitions',
            timerSource('run()', timers++)
        ) as Timer;
    }

    createAsyncTimer(): AsyncTimer {
        return new AsyncFunction(
            'run',
            'repetitions',
            timerSource('await run()', timers++)
        );
    }
}

/**
 * A timer loop's source, which keeps the last result alive in a global, so
 * that V8 can't eliminate the calls
 */
function timerSource(call: string, id: number): string {
    return `let result;
        const start = performance.now();
        for (let i = 0; i < repetitions; i++) {
            result = ${call};
        }
        const elapsed = performance.now() - start;
        globalThis.benkSink = result;
        return elapsed; // timer ${id}`;
}

/**
 * Starts counting the bytes allocated on V8's heap: how much the heap's used
 * size grows, and what garbage collections free meanwhile, which a
 * `GCProfiler` reports. V8 allocates the contents of an `ArrayBuffer` of more
 * than 64 bytes outside its heap, so they're left out.
 */
function startCounting(): () => number {
    const profiler = new GCProfiler();
    profiler.start();
    const before = getHeapStatistics().used_heap_size;

    return () => {
        const after = getHeapStatistics().used_heap_size;
        return after - before + freedBytes(profiler.stop());
    };
}

function freedBytes({ statistics }: GCProfilerResult): number {
    let freed = 0;
    for (const { beforeGC, afterGC } of statistics) {
        freed +=
            beforeGC.heapStatistics.usedHeapSize -
            afterGC.heapStatistics.usedHeapSize;
    }

    return freed;
}

function describeNode(): RuntimeDescription {
    const nodeOptions = process.env.NODE_OPTIONS ?? '';

    return {
        name: 'Node',
        version: process.version,
        engine: `V8 ${process.versions.v8}`,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model.trim() ?? 'unknown',
        flags: [
            ...process.execArgv,
            ...(nodeOptions === '' ? [] : [`NODE_OPTIONS=${nodeOptions}`])
        ]
    };
}
