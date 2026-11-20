// The tick of a runtime's clock, which the core can't read itself: it times
// empty calls in a timer loop of its own, and takes the shortest time that
// the loop reads as the tick.
import type { Runtime, Timer } from './types.ts';

/**
 * The calls of an empty function in one loop after which a clock that still
 * reads no time is taken as frozen. Under a clock that never moved, doubling
 * the calls up to this many took 0.96 s in Node 26.13.0 on an Apple M2 Pro,
 * where a clock floored to 16 ms read its first tick within 2^25 calls.
 */
const FROZEN_CALLS = 2 ** 30;

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

const ticks = new WeakMap<Runtime, number>();

/**
 * The tick of a runtime's clock in nanoseconds, as `estimateTick()` gives
 * it, which it keeps between groups, as the clock's tick doesn't change. It
 * takes a timer loop of the runtime's own the first time.
 *
 * @throws {Error} If the clock reads no time in a loop of `FROZEN_CALLS`
 * empty calls.
 */
export function clockTickOf(runtime: Runtime): number {
    let tick = ticks.get(runtime);
    if (tick === undefined) {
        tick = estimateTick(runtime.createTimer());
        ticks.set(runtime, tick);
    }

    return tick;
}

/**
 * Estimates the tick of the clock that a timer loop reads, in nanoseconds:
 * the shortest time other than 0 that the loop reads for empty calls. In
 * each pass, it doubles the calls from 1 until a loop reads time, and then
 * times loops of half as many calls. Where the clock is finer than the
 * loop's own time, as Node's is, it gives the loop's own time instead, so
 * the estimate is never shorter than the tick.
 */
function estimateTick(timer: Timer): number {
    let shortest = Infinity;
    for (let pass = 0; pass < PASSES; pass++) {
        const { calls, elapsed } = firstReading(timer);
        const half = Math.max(1, calls / 2);

        shortest = Math.min(shortest, elapsed, shortestReading(timer, half));
    }

    return shortest * 1e6;
}

interface Reading {
    readonly calls: number;
    /** The loop's time in milliseconds */
    readonly elapsed: number;
}

/**
 * The first loop that reads time, of calls that double from 1
 *
 * @throws {Error} If none does by `FROZEN_CALLS` calls.
 */
function firstReading(timer: Timer): Reading {
    for (let calls = 1; ; calls *= 2) {
        const elapsed = timer(empty, calls);
        if (elapsed > 0) {
            return { calls, elapsed };
        }

        if (calls >= FROZEN_CALLS) {
            throw new Error(
                `Expected the runtime's clock to advance, but a loop of ${calls.toLocaleString('en-US')} empty calls read no time`
            );
        }
    }
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
