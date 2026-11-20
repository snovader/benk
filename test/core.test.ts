// The core's entry point, which a script imports where Node's modules are
// missing. This file imports it only after it has started recording what's
// loaded, and imports nothing else of benk's that's more than types.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import type { AsyncTimer, Timer } from 'benk/core';
import { FakeRuntime } from './fake-runtime.ts';

/** The modules of Node that modules other than this file's own imported */
const nodeModules: string[] = [];

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (resolved.url.startsWith('node:') && context.parentURL !== import.meta.url) {
            nodeModules.push(`${specifier} from ${context.parentURL}`);
        }

        return resolved;
    }
});

const { asyncTimerSource, measureGroup, measureGroups, timerSource } = await import('benk/core');

const QUICK = { sampleTime: 0.01, warmupRounds: 1, rounds: 6, heap: false };

describe('benk/core', () => {
    it("loads none of Node's modules", () => {
        assert.deepEqual(nodeModules, []);
    });

    it('measures a group with the runtime that its options name', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroup(
            { name: 'calls', variants: [runtime.variant('a', 100), runtime.variant('b', 200)] },
            { ...QUICK, runtime }
        );

        const [a, b, copy] = result.variants;

        assert.deepEqual(
            result.variants.map(variant => variant.name),
            ['a', 'b', 'a A/A']
        );
        // The fake clock's sums round
        assert.ok(Math.abs(a.summary.median - 100) < 1e-9, `${a.summary.median} ns`);
        assert.ok(Math.abs(b.ratio - 2) < 1e-9, `${b.ratio}`);
        assert.ok(Math.abs(copy.ratio - 1) < 1e-9, `${copy.ratio}`);
    });

    it('records the runtime of a run of groups', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroups(
            [
                { name: 'first', variants: [runtime.variant('a', 100)] },
                { name: 'second', variants: [runtime.variant('a', 100)] }
            ],
            { ...QUICK, filter: /second/u, runtime }
        );

        assert.deepEqual(result.runtime, runtime.description);
        assert.deepEqual(
            result.groups.map(group => group.name),
            ['second']
        );
    });
});

/** A function expression of a timer loop, as a build step would write it */
function loopExpression(body: string, async: boolean): string {
    return `${async ? 'async ' : ''}function (run, repetitions) {\n${body}\n}`;
}

function compile(expression: string): unknown {
    // oxlint-disable-next-line typescript/no-implied-eval -- Compiles the source that's tested
    const evaluate = new Function(`return ${expression};`) as () => unknown;

    return evaluate();
}

describe('timerSource', () => {
    it('is the body of a loop that calls `run` and returns a time', () => {
        const timer = compile(loopExpression(timerSource(0), false)) as Timer;
        let calls = 0;

        const elapsed = timer(() => ++calls, 1000);

        assert.equal(calls, 1000);
        assert.ok(elapsed >= 0 && elapsed < 1000, `${elapsed} ms`);
    });

    it('is the body of a loop that awaits each call', async () => {
        const timer = compile(loopExpression(asyncTimerSource(0), true)) as AsyncTimer;
        let pending = 0;
        let overlapped = false;

        const elapsed = await timer(async () => {
            overlapped ||= pending > 0;
            pending++;
            await Promise.resolve();
            pending--;
        }, 100);

        assert.equal(overlapped, false);
        assert.ok(elapsed >= 0 && elapsed < 1000, `${elapsed} ms`);
    });

    it('differs for each id, so that no two loops share a source', () => {
        fc.assert(
            fc.property(fc.uniqueArray(fc.nat(), { minLength: 2 }), ids => {
                const sources = new Set([
                    ...ids.map(id => timerSource(id)),
                    ...ids.map(id => asyncTimerSource(id))
                ]);

                assert.equal(sources.size, 2 * ids.length);
            })
        );
    });
});
