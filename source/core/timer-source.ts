// The source of benk's timer loops, which a runtime compiles: Node's with
// `new Function`, and one for a runtime that forbids compiling strings from
// a module that a build step writes with a loop for each variant.

/**
 * The body of a timer loop, of a function that takes `run` and
 * `repetitions`: it calls `run` that many times and returns the time that
 * the calls took, in milliseconds. It keeps the last result alive in a
 * global, so that V8 can't eliminate the calls.
 *
 * Each variant needs a loop compiled from a source of its own, which `id`
 * numbers: identical sources would share their compiled code and feedback
 * through V8's compilation cache, as closures of one function share theirs.
 * So a caller gives each loop that it creates in a process another `id`.
 *
 * The body ends with a comment, so a function's closing brace goes on a
 * line after it.
 */
export function timerSource(id: number): string {
    return loopSource('run()', id);
}

/**
 * The body of a timer loop like `timerSource()`'s, of an async function,
 * which awaits each call before the next. Its `id`s are those of
 * `timerSource()`: a sync loop and an async one differ anyway.
 */
export function asyncTimerSource(id: number): string {
    return loopSource('await run()', id);
}

function loopSource(call: string, id: number): string {
    return `let result;
        const start = performance.now();
        for (let i = 0; i < repetitions; i++) {
            result = ${call};
        }
        const elapsed = performance.now() - start;
        globalThis.benkSink = result;
        return elapsed; // timer ${id}`;
}
