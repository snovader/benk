// The resolution of a runtime's timer loops: the shortest time that one
// reads. The core can't read a clock itself, so it times empty calls in a
// timer loop of its own. Where the clock is coarse, that's the clock's tick.
import type { Runtime, Timer } from './types.ts';

/**
 * The calls of an empty function in one loop after which the estimate gives
 * up on a clock that still reads no time. Such a clock is frozen, or moves
 * only when a variant's call moves it, as a test's virtual clock does, or
 * has a tick longer than the loops took.
 *
 * Doubling the calls up to this many took 61 ms in Node 26.13.0 on an Apple
 * M2 Pro, and 2.1 s with `--jitless`, so that's what a runtime whose clock
 * reads nothing costs, once. A clock floored to 16 ms read its first tick
 * within 2^25 calls there.
 */
const GIVE_UP_CALLS = 2 ** 26;

/**
 * The passes of the estimate, of whose readings the shortest counts. The
 * first pass's loops run cold code, which can take several ticks of a fine
 * clock, as V8 compiles it.
 *
 * The constants of the estimate were chosen in Node 26.13.0 on an Apple M2
 * Pro, with `performance.now()` floored to 1 µs, 5 µs, 20 µs, 100 µs and
 * 1 ms, from 500 estimates of each. Of the 2,500, these gave 2 ticks or
 * more:
 *
 * - 45, and up to 32, of one pass without the loops of `HALF_LOOPS`;
 * - 8, and up to 4, of one pass with them;
 * - 1 of two passes without them;
 * - none of two passes with them.
 */
const PASSES = 2;

/**
 * The loops of half the calls that first read time, in each pass. A loop of
 * half the calls read no time when the doubling passed it, so it takes less
 * than a tick, and reads either no time or exactly one tick. The loop that
 * first read time can read two, when it took more than a tick, or when the
 * code between it and the loop before it took time.
 */
const HALF_LOOPS = 8;

/** The function that the estimate's loop calls, which does nothing */
function empty(): undefined {
    return undefined;
}

const resolutions = new WeakMap<Runtime, number | null>();

/**
 * The resolution of a runtime's timer loops in nanoseconds, as
 * `estimateResolution()` gives it, or null where the clock read no time. It
 * keeps it between groups, as a clock's tick doesn't change, and takes a
 * timer loop of the runtime's own the first time.
 */
export function timerResolutionOf(runtime: Runtime): number | null {
    let resolution = resolutions.get(runtime);
    if (resolution === undefined) {
        resolution = estimateResolution(runtime.createTimer());
        resolutions.set(runtime, resolution);
    }

    return resolution;
}

/**
 * Estimates the shortest time other than 0 that a timer loop reads, in
 * nanoseconds, from loops of empty calls. In each pass, it doubles the calls
 * from 1 until a loop reads time, and then times loops of half as many
 * calls. Where the clock is coarse, that's its tick. Where the clock is
 * finer than the loop's own time, as Node's is, it's the loop's own time,
 * which is longer than the tick. It's null if no loop of up to
 * `GIVE_UP_CALLS` calls reads time.
 */
function estimateResolution(timer: Timer): number | null {
    let shortest = Infinity;
    for (let pass = 0; pass < PASSES; pass++) {
        const first = firstReading(timer);
        if (first === undefined) {
            return null;
        }

        const half = Math.max(1, first.calls / 2);
        shortest = Math.min(
            shortest,
            first.elapsed,
            shortestReading(timer, half)
        );
    }

    return shortest * 1e6;
}

interface Reading {
    readonly calls: number;
    /** The loop's time in milliseconds */
    readonly elapsed: number;
}

/**
 * The first loop that reads time, of calls that double from 1, or undefined
 * if none does by `GIVE_UP_CALLS` calls
 */
function firstReading(timer: Timer): Reading | undefined {
    for (let calls = 1; calls <= GIVE_UP_CALLS; calls *= 2) {
        const elapsed = timer(empty, calls);
        if (elapsed > 0) {
            return { calls, elapsed };
        }
    }

    return undefined;
}

/**
 * The shortest time other than 0 that `HALF_LOOPS` loops of `calls` calls
 * read, in milliseconds, or Infinity if none reads time
 */
function shortestReading(timer: Timer, calls: number): number {
    let shortest = Infinity;
    for (let loop = 0; loop < HALF_LOOPS; loop++) {
        const elapsed = timer(empty, calls);
        if (elapsed > 0 && elapsed < shortest) {
            shortest = elapsed;
        }
    }

    return shortest;
}
