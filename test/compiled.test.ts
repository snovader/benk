// What a script compiles from a source of its own: copies of functions,
// functions from text, and inputs in turn. That a copy's feedback is its own
// is V8's, which `benchmarks/own-source.ts` measures: these check what a
// caller sees of a copy.
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { compiledCopy, compiledFrom, inTurn } from 'benk';
import * as d8 from 'benk/d8';

/** A variable of this module, which a copy can't read */
const OFFSET = 7;

function counter(start: number): () => number {
    let count = start;

    return () => count++;
}

describe('compiledCopy', () => {
    it.prop([fc.integer(), fc.integer()])('returns what the function does', (a, b) => {
        const add = (x: number, y: number): number => (x + y) | 0;

        expect(compiledCopy(add)(a, b)).toBe(add(a, b));
    });

    it('copies a function that returns the call, with what the call needs as parameters', () => {
        const copy = compiledCopy(counter);
        const [first, second] = [copy(5), copy(10)];

        expect([first(), first(), second(), first()]).toStrictEqual([5, 6, 10, 7]);
        expect(copy).not.toBe(counter);
    });

    it('copies functions of each kind whose text is an expression', async () => {
        const named = compiledCopy(function double(x: number): number {
            return x * 2;
        });
        // oxlint-disable-next-line typescript/require-await -- An async function is what's copied
        const later = compiledCopy(async (x: number): Promise<number> => x + 1);
        const numbers = compiledCopy(function* (count: number): Generator<number> {
            for (let i = 0; i < count; i++) {
                yield i;
            }
        });
        const Point = compiledCopy(
            class {
                readonly x = 3;
            }
        );

        expect(named(4)).toBe(8);
        expect(named.name).toBe('double');
        expect(await later(4)).toBe(5);
        expect(Array.from(numbers(3))).toStrictEqual([0, 1, 2]);
        expect(new Point().x).toBe(3);
    });

    it('copies the function body even when the function overrides toString', () => {
        const one = (): number => 1;
        one.toString = () => '() => 2';

        expect(compiledCopy(one)()).toBe(1);
    });

    it('reads nothing of the scope that the function was written in, which is an error at its call', () => {
        const shift = (x: number): number => x + OFFSET;
        const copy = compiledCopy(shift);

        expect(shift(1)).toBe(8);
        expect(() => copy(1)).toThrow(ReferenceError);
    });

    it('is strict code, as a module is', () => {
        const self = compiledCopy(function (this: unknown): unknown {
            return this;
        });

        expect(self()).toBeUndefined();
    });

    it('rejects a function whose text is no expression', () => {
        const methods = {
            method(this: void): number {
                return 1;
            }
        };
        const bound = counter.bind(null);

        for (const fn of [methods.method, bound, Math.max]) {
            expect(() => compiledCopy(fn)).toThrow(SyntaxError);
            expect(() => compiledCopy(fn)).toThrow(/^Expected the text of a function expression/);
        }
    });
});

describe('compiledFrom', () => {
    it('returns a callable function when no signature is given', () => {
        expect(compiledFrom('() => 1')()).toBe(1);
    });

    it('compiles the text of a function, also between line breaks and before a comment', () => {
        const add = compiledFrom<(a: number, b: number) => number>(`
            (a, b) => a + b // The sum
        `);

        expect(add(2, 3)).toBe(5);
    });

    it('compiles a function of its own from the same text', () => {
        const text = '() => { let count = 0; return () => count++; }';
        const [first, second] = [
            compiledFrom<() => () => number>(text),
            compiledFrom<() => () => number>(text)
        ];

        expect(first).not.toBe(second);
        expect([first()(), second()()]).toStrictEqual([0, 0]);
    });

    it('rejects text that is no expression, with what V8 said of it as the cause', () => {
        const compile = (): unknown => compiledFrom('(a, b => a');

        expect(compile).toThrow(SyntaxError);
        expect(compile).toThrow(/^Expected the text of a function expression.* got \(a, b => a$/);
    });

    it('rejects an expression that is no function, and quotes the start of a long one', () => {
        expect(() => compiledFrom('42')).toThrow(TypeError);
        expect(() => compiledFrom('42')).toThrow(
            'Expected the text of a function, got that of a number: 42'
        );
        expect(() => compiledFrom(`[${'1, '.repeat(40)}]`)).toThrow(/: \[(1, ){19}1,…$/);
    });
});

describe('inTurn', () => {
    it.prop([fc.array(fc.anything(), { minLength: 1 }), fc.integer({ min: 0, max: 50 })])(
        'returns the inputs one after another, and the first again after the last',
        (inputs, calls) => {
            const next = inTurn(inputs);
            const taken = Array.from({ length: calls }, () => next());

            expect(taken.every((input, i) => Object.is(input, inputs[i % inputs.length]))).toBe(
                true
            );
        }
    );

    it('gives each function turns of its own', () => {
        const inputs = ['a', 'b', 'c'];
        const [first, second] = [inTurn(inputs), inTurn(inputs)];

        expect([first(), first(), second(), first()]).toStrictEqual(['a', 'b', 'a', 'c']);
    });

    it('keeps the inputs that it was given, whatever becomes of the array', () => {
        const inputs = [1, 2];
        const next = inTurn(inputs);
        inputs.push(3);
        inputs[0] = 4;

        expect([next(), next(), next()]).toStrictEqual([1, 2, 1]);
    });

    it('rejects no inputs', () => {
        expect(() => inTurn([])).toThrow(RangeError);
        expect(() => inTurn([])).toThrow('Expected at least one input to take in turn');
    });
});

describe('benk/d8', () => {
    it('compiles copies and takes inputs in turn as benk does', () => {
        const next = d8.inTurn([1, 2]);

        expect(d8.compiledCopy(counter)(3)()).toBe(3);
        expect(d8.compiledFrom<() => number>('() => 1')()).toBe(1);
        expect([next(), next(), next()]).toStrictEqual([1, 2, 1]);
    });
});
