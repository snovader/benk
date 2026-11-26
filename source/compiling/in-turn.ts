// Inputs that a variant's calls take in turn, so that V8 can't compile a
// call for one constant input, for the hosts that compile strings.
import { compiledFrom } from './compiled-copy.ts';

/** Creates the function that `inTurn()` returns, from a copy of the inputs */
type CreateNext<T> = (inputs: T[]) => () => T;

/**
 * The text of the function that hands out inputs in turn. Each `inTurn()`
 * compiles it as a source of its own, since closures of one function
 * literal would share the feedback of the load of `inputs[next]`, which
 * would then have seen every script's kinds of input, and V8 inlines that
 * load into each variant's call.
 *
 * It compares rather than takes a remainder, which would divide by a count
 * that isn't a constant.
 */
const NEXT_SOURCE = `inputs => {
    const count = inputs.length;
    let next = 0;

    return () => {
        const input = inputs[next];
        next = next + 1 === count ? 0 : next + 1;

        return input;
    };
}`;

/**
 * A function that returns the inputs one after another, and the first again
 * after the last. A variant whose call takes `next()` rather than one input
 * times the call as a caller with varying data runs it: V8 inlines an input
 * that's the same every time into the timer loop as a constant, and can
 * compile the call for it.
 *
 * The inputs are in turn over a variant's calls, not over its rounds, and
 * one function that several variants call gives each of them some of the
 * inputs. So give each variant a function of its own, of inputs of one
 * kind: of the same class, and for arrays the same kind of elements.
 *
 * It keeps a copy of the array, and adds a load, a compare and two stores
 * to each call, which the README measures.
 *
 * @throws {RangeError} If there are no inputs.
 */
export function inTurn<T>(inputs: readonly T[]): () => T {
    if (inputs.length === 0) {
        throw new RangeError('Expected at least one input to take in turn');
    }

    return compiledFrom<CreateNext<T>>(NEXT_SOURCE)(inputs.slice());
}
