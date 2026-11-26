// Functions that a benchmark script compiles from a source of its own, for
// the hosts that compile strings, as Node and d8 do. The core compiles
// none, so this is apart from it, and `benk/core` doesn't export it.

/** Any function, of whatever parameters */
type AnyFunction = (...args: never[]) => unknown;

/**
 * The functions compiled in the process, which numbers each one's source:
 * identical sources would share their compiled code and feedback through
 * V8's compilation cache
 */
let copies = 0;

/**
 * A copy of a function, compiled again from its text, as `compiledFrom()`
 * compiles it. The copy's call sites keep type feedback of their own, where
 * the closures of one function literal share theirs: a script that makes a
 * variant for each class from one function would otherwise time each class
 * through call sites that have seen them all.
 *
 * The copy reads nothing of the scope that `fn` was written in: no
 * variable of its module or of a function around it, and no import. It
 * reads its parameters, what it declares, and globals. So a function to
 * copy takes what its calls need as parameters, and returns the call that a
 * variant runs. A name that it reads from its scope anyway is a
 * `ReferenceError` when the copy's code reaches it, or the global of that
 * name, if there's one.
 *
 * The text is what the host runs: without its types where a hook or Node
 * stripped them, and with a bundle's or a minifier's names.
 *
 * @throws {SyntaxError} If the function's text isn't an expression, as a
 * method's, a getter's, a bound function's or a built-in's isn't.
 */
export function compiledCopy<F extends AnyFunction>(fn: F): F {
    return compiledFrom<F>(fn.toString());
}

/**
 * A function compiled from the text of a function expression, such as
 * `'(a, b) => a + b'`, as a source of its own, which no other function
 * shares, even one of the same text. It is strict code, as a module's is,
 * and reads only its parameters, what it declares, and globals.
 *
 * It's for a call whose text differs between variants, such as by the name
 * of the method that it calls. `compiledCopy()` copies a function that's
 * written as code.
 *
 * @throws {SyntaxError} If the text isn't an expression.
 * @throws {TypeError} If the expression isn't a function.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- The caller says what the text is a function of, which a cast at each call would say worse
export function compiledFrom<F extends AnyFunction>(source: string): F {
    // The text is on lines of its own: it may start with a line break,
    // after which `return` would return nothing, or end with a comment
    const body = `'use strict';
        return (
${source}
        ); // copy ${copies++}`;

    const compiled = evaluate(body, source);
    if (typeof compiled !== 'function') {
        throw new TypeError(
            `Expected the text of a function, got that of a ${typeof compiled}: ${excerpt(source)}`
        );
    }

    return compiled as F;
}

/** The value of the expression that a body returns */
function evaluate(body: string, source: string): unknown {
    let create: () => unknown;
    try {
        // oxlint-disable-next-line typescript/no-implied-eval -- A source of its own is what the caller asks for
        create = new Function(body) as () => unknown;
    } catch (error) {
        throw new SyntaxError(
            `Expected the text of a function expression, such as an arrow function's, got ${excerpt(source)}`,
            { cause: error }
        );
    }

    return create();
}

/** The most of a function's text that an error's message quotes */
const EXCERPT_LENGTH = 60;

function excerpt(source: string): string {
    return source.length > EXCERPT_LENGTH
        ? `${source.slice(0, EXCERPT_LENGTH)}…`
        : source;
}
