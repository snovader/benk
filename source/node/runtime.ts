// What benk needs from Node to time variants: timer loops that `new Function`
// compiles, and V8's heap statistics. Workers and browsers that forbid
// `new Function`, and runtimes without `node:v8`, need a runtime of their own.
import { cpus } from 'node:os';
import { getHeapStatistics, GCProfiler, type GCProfilerResult } from 'node:v8';
import type {
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
 * script, although it can't see whether other code detached a buffer. These
 * name where the code came from, not what stripped its types: a hook can
 * strip them instead, as `@snovader/node-hooks` does with oxc.
 */
const fromSource = import.meta.url.endsWith('.ts');

const TYPESCRIPT_ENTRY = 'entry script from TypeScript source';

/**
 * Whether the process's entry script is TypeScript, as a benchmark that
 * `node bench.ts` runs is, also with benk's bundle. Node strips its types
 * as it does those of benk's source, which detaches an ArrayBuffer when
 * the file is large enough. The modules that it imports aren't seen.
 */
function entryFromSource(): boolean {
    return /\.[cm]?ts$/u.test(process.argv[1] ?? '');
}

const NODE_STRIPPING_OFF = "Node's type stripping off";

/**
 * Whether Node's own type stripping is off, as `--no-strip-types` turns
 * it. Node then strips no module's types, and so detaches no buffer for
 * one, also among the modules that the entry script imports: a hook loaded
 * whatever TypeScript the process runs. With Node's stripping on, the
 * runtime can't see whether Node or a hook stripped a module's types.
 */
const nodeStrippingOff = process.features.typescript === false;

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
    readonly heap: HeapMeter = { start: startCounting };

    /** Node's version and flags, and what benk set in the process */
    get description(): RuntimeDescription {
        return describeNode();
    }

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
        ],
        processState: [
            ...(fromSource ? [TYPESCRIPT_SOURCE] : []),
            ...(entryFromSource() ? [TYPESCRIPT_ENTRY] : []),
            ...(nodeStrippingOff ? [NODE_STRIPPING_OFF] : [])
        ]
    };
}
