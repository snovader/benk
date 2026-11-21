// What benk needs from d8, the V8 shell, to time variants: timer loops that
// `new Function` compiles, as Node's are, and what d8 knows of itself from
// the globals that it adds. d8 has no `node:v8`, so the runtime counts no
// heap bytes.
import { asyncTimerSource, timerSource } from '#source/core/timer-source';
import type {
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
 * bytes, which d8 has no API for, and its description reads d8's globals,
 * so it describes only a run in d8.
 */
export class D8Runtime implements Runtime {
    readonly heap = undefined;

    /** d8's version, its platform, and the bits of V8's small integers */
    get description(): RuntimeDescription {
        return describeD8();
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

function describeD8(): RuntimeDescription {
    const v8 = version();

    return {
        name: 'd8',
        // d8's version is V8's
        version: v8,
        engine: `V8 ${v8}`,
        platform: os.name,
        // d8 knows neither, nor the flags that it started with
        arch: 'unknown',
        cpu: 'unknown',
        flags: ['unknown'],
        processState: [`${smallIntegerBits()}-bit small integers`]
    };
}
