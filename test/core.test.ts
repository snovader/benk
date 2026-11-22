// The core's entry point, which a script imports where Node's modules are
// missing. This file imports it only after it has started recording what's
// loaded, and imports nothing else of benk's that's more than types.
import { registerHooks } from 'node:module';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import type { AsyncTimer, Group, Timer, Variant } from 'benk/core';
import { expectClose } from './expectations.ts';
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
        expect(nodeModules).toStrictEqual([]);
    });

    it('measures a group with the runtime that its options name', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroup(
            { name: 'calls', variants: [runtime.variant('a', 100), runtime.variant('b', 200)] },
            { ...QUICK, runtime }
        );

        const [a, b, copy] = result.variants;

        expect(result.variants.map(variant => variant.name)).toStrictEqual(['a', 'b', 'a A/A']);
        // The fake clock's sums round
        expectClose(a.summary.median, 100);
        expectClose(b.ratio, 2);
        expectClose(copy.ratio, 1);
    });

    it('records the runtime of a run of groups', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroups(
            [
                { name: 'first', variants: [runtime.variant('a', 100)] },
                { name: 'second', variants: [runtime.variant('a', 100)] }
            ],
            { ...QUICK, filter: /second/, runtime }
        );

        expect(result.runtime).toStrictEqual(runtime.description);
        expect(result.groups.map(group => group.name)).toStrictEqual(['second']);
    });

    it.prop([fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 3 }), fc.boolean()])(
        "calls onRounds just before each group's timed rounds, and just after them",
        async (rounds, warmupRounds, heap) => {
            const runtime = new FakeRuntime();
            const events: string[] = [];
            let calls = 0;
            const counted = (name: string): Variant => {
                const { run } = runtime.variant(name, 100);
                return {
                    name,
                    run: () => {
                        calls++;
                        return run();
                    }
                };
            };
            const groups: Group[] = [
                { name: 'first', variants: [counted('a'), counted('b')] },
                { name: 'second', variants: [counted('c')] }
            ];

            const result = await measureGroups(groups, {
                ...QUICK,
                rounds,
                warmupRounds,
                heap,
                aa: false,
                runtime,
                onRounds: (group, phase) => {
                    events.push(`${phase} ${group.name}`);
                    // Counts the calls of the timed rounds from 0
                    if (phase === 'timed') {
                        calls = 0;
                    } else {
                        events.push(`${calls} calls`);
                    }
                },
                onGroup: group => events.push(`results ${group.name}`)
            });

            const timedCalls = result.groups.map(
                group =>
                    `${group.variants.reduce((sum, v) => sum + group.rounds * v.repetitions, 0)} calls`
            );
            expect(events).toStrictEqual([
                'timed first',
                'done first',
                timedCalls[0],
                'results first',
                'timed second',
                'done second',
                timedCalls[1],
                'results second'
            ]);
        }
    );
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

        expect(calls).toBe(1000);
        expect(elapsed).toBeGreaterThanOrEqual(0);
        expect(elapsed).toBeLessThan(1000);
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

        expect(overlapped).toBe(false);
        expect(elapsed).toBeGreaterThanOrEqual(0);
        expect(elapsed).toBeLessThan(1000);
    });

    it.prop([fc.uniqueArray(fc.nat(), { minLength: 2 })])(
        'differs for each id, so that no two loops share a source',
        ids => {
            const sources = new Set([
                ...ids.map(id => timerSource(id)),
                ...ids.map(id => asyncTimerSource(id))
            ]);

            expect(sources.size).toBe(2 * ids.length);
        }
    );
});
