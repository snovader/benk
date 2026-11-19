import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import { formatJson, measureGroup, measureGroups, type GroupResult, type SyncVariant } from 'benk';
import { FakeRuntime } from './fakeRuntime.ts';

/** Options that keep the fake loops short: about 200 calls of 50 ns a round */
const QUICK = { sampleTime: 0.01, warmupRounds: 2 };

/** Whether two times agree, apart from the rounding of the fake clock's sums */
function assertClose(actual: number, expected: number, message?: string): void {
    assert.ok(Math.abs(actual - expected) <= expected * 1e-9, message ?? `${actual} ≉ ${expected}`);
}

function variantNamed(result: GroupResult, name: string): GroupResult['variants'][number] {
    const variant = result.variants.find(v => v.name === name);
    assert.ok(variant !== undefined, `no variant named ${name}`);

    return variant;
}

describe('measureGroup', () => {
    it('times each variant per call, and compares it with the first', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroup(
            { name: 'calls', variants: [runtime.variant('a', 50), runtime.variant('b', 100)] },
            { ...QUICK, runtime }
        );

        assert.deepEqual(
            result.variants.map(({ name, role }) => [name, role]),
            [
                ['a', 'reference'],
                ['b', 'variant'],
                ['a A/A', 'aa']
            ]
        );
        for (const [name, time, ratio] of [
            ['a', 50, 1],
            ['b', 100, 2],
            ['a A/A', 50, 1]
        ] as const) {
            const { summary, samples } = variantNamed(result, name);
            assert.equal(samples.length, result.rounds);
            assertClose(summary.fastest, time);
            assertClose(summary.median, time);
            assertClose(variantNamed(result, name).ratio, ratio);
        }

        const b = variantNamed(result, 'b');
        assert.ok(b.interval !== null);
        assertClose(b.interval[0], 2);
        assertClose(b.interval[1], 2);
        assert.equal(variantNamed(result, 'a').interval, null);
    });

    it('takes every variant through every position equally often, in whole rotations', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 6 }),
                fc.integer({ min: 1, max: 40 }),
                fc.boolean(),
                async (count, rounds, aa) => {
                    const runtime = new FakeRuntime({ heap: false });
                    const variants = Array.from({ length: count }, (_, i) =>
                        runtime.variant(`v${i}`, 10 * (i + 1))
                    );
                    const result = await measureGroup(
                        { name: 'positions', variants },
                        { ...QUICK, rounds, aa, runtime }
                    );
                    const total = count + (aa ? 1 : 0);

                    assert.equal(result.variants.length, total);
                    assert.ok(result.rounds >= rounds);
                    assert.ok(result.rounds < rounds + 2 * total);
                    for (const { positions } of result.variants) {
                        const counts = new Array<number>(total).fill(0);
                        for (const position of positions) {
                            counts[position]++;
                        }
                        assert.deepEqual(
                            counts,
                            new Array<number>(total).fill(result.rounds / total)
                        );
                    }
                }
            ),
            { numRuns: 40 }
        );
    });

    it('leaves out the A/A copy when the run or the group asks', async () => {
        const runtime = new FakeRuntime();
        const variants = [runtime.variant('a', 10)];

        const off = await measureGroup({ name: 'off', variants }, { ...QUICK, aa: false, runtime });
        const groupOff = await measureGroup(
            { name: 'group off', variants, aa: false },
            { ...QUICK, runtime }
        );
        const groupOn = await measureGroup(
            { name: 'group on', variants, aa: true },
            { ...QUICK, aa: false, runtime }
        );

        assert.deepEqual(
            [off, groupOff, groupOn].map(result => result.variants.map(v => v.name)),
            [['a'], ['a'], ['a', 'a A/A']]
        );
    });

    it('runs setup before and teardown after each loop, untimed, with its calls', async () => {
        const runtime = new FakeRuntime();
        let inputs: number[] = [];
        let tornDown = true;
        const variant: SyncVariant = {
            name: 'consumes inputs',
            setup: calls => {
                assert.ok(tornDown, 'setup again before teardown');
                tornDown = false;
                // Slow, but untimed
                runtime.clock.spend(1e9);
                inputs = new Array<number>(calls).fill(25);
            },
            run: () => {
                const input = inputs.pop();
                assert.ok(input !== undefined, 'more calls than setup prepared');
                runtime.clock.spend(input);
            },
            teardown: () => {
                assert.deepEqual(inputs, [], 'fewer calls than setup prepared');
                tornDown = true;
            }
        };

        const result = await measureGroup(
            { name: 'setup', variants: [variant] },
            { ...QUICK, runtime }
        );

        for (const { summary } of result.variants) {
            assertClose(summary.fastest, 25);
            assertClose(summary.slowest, 25);
        }
        assert.ok(tornDown);
    });

    it('awaits the calls of async variants, beside sync ones', async () => {
        const runtime = new FakeRuntime();
        let pending = 0;
        const result = await measureGroup(
            {
                name: 'async',
                variants: [
                    runtime.variant('sync', 40),
                    {
                        name: 'async',
                        async: true,
                        setup: () => Promise.resolve(),
                        run: async () => {
                            pending++;
                            await Promise.resolve();
                            runtime.clock.spend(120);
                            pending--;
                        }
                    }
                ]
            },
            { ...QUICK, runtime }
        );

        const async = variantNamed(result, 'async');
        assert.equal(async.async, true);
        assert.equal(variantNamed(result, 'sync').async, false);
        assertClose(async.summary.median, 120);
        assertClose(async.ratio, 3);
        assert.equal(pending, 0);
    });

    it('rejects a sync variant whose call returns a promise', async () => {
        const runtime = new FakeRuntime();
        await assert.rejects(
            measureGroup(
                {
                    name: 'group',
                    variants: [{ name: 'unmarked', run: () => Promise.reject(new Error('x')) }]
                },
                { ...QUICK, runtime }
            ),
            { name: 'TypeError', message: /"unmarked" of group "group" returned a promise/u }
        );
    });

    it('rejects with the variant and group of a call that throws, and its error as the cause', async () => {
        const runtime = new FakeRuntime();
        const cause = new Error('broken');
        let calls = 0;
        const throwsLater: SyncVariant = {
            name: 'throws',
            run: () => {
                calls++;
                runtime.clock.spend(100);
                if (calls > 1000) {
                    throw cause;
                }
            }
        };

        await assert.rejects(
            measureGroup({ name: 'group', variants: [throwsLater] }, { ...QUICK, runtime }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /"throws" of group "group" threw/u);
                assert.equal(error.cause, cause);
                return true;
            }
        );
    });

    it('rejects options out of their range', async () => {
        const runtime = new FakeRuntime();
        const group = { name: 'group', variants: [runtime.variant('a', 10)] };

        for (const options of [
            { rounds: 0 },
            { rounds: 1.5 },
            { warmupRounds: -1 },
            { sampleTime: 0 },
            { sampleTime: Number.NaN },
            { sampleTime: Infinity }
        ]) {
            await assert.rejects(measureGroup(group, { ...options, runtime }), RangeError);
        }
    });

    it('rejects a group without variants, or with two of the same name', async () => {
        const runtime = new FakeRuntime();
        const a = runtime.variant('a', 10);

        await assert.rejects(measureGroup({ name: 'empty', variants: [] }, { runtime }), TypeError);
        await assert.rejects(
            measureGroup({ name: 'twice', variants: [a, a] }, { runtime }),
            TypeError
        );
        await assert.rejects(
            measureGroup({ name: 'A/A', variants: [a, runtime.variant('a A/A', 10)] }, { runtime }),
            TypeError
        );

        const named = await measureGroup(
            { name: 'A/A', variants: [a, runtime.variant('a A/A', 10)] },
            { ...QUICK, aa: false, runtime }
        );
        assert.equal(named.variants.length, 2);
    });

    it('counts the bytes that a call allocates, less what a sample counts of its own', async () => {
        const runtime = new FakeRuntime({ heapOverhead: 5000 });
        const result = await measureGroup(
            {
                name: 'heap',
                variants: [
                    runtime.variant('none', 50),
                    runtime.variant('some', 50, 48),
                    runtime.asyncVariant('async', 50, 24)
                ]
            },
            { ...QUICK, runtime }
        );

        assert.deepEqual(
            result.variants.map(({ name, heapBytes }) => [name, heapBytes]),
            [
                ['none', 0],
                ['some', 48],
                ['async', 24],
                ['none A/A', 0]
            ]
        );
    });

    it('counts the median sample, which a sample counting too few or too many bytes leaves alone', async () => {
        // In any 5 samples in a row, one counts a megabyte too few, and one
        // 300 KB too many
        const runtime = new FakeRuntime({ heapErrors: [0, -1e6, 0, 3e5, 0] });
        const result = await measureGroup(
            { name: 'heap', variants: [runtime.variant('some', 50, 48)] },
            { ...QUICK, runtime }
        );

        assert.deepEqual(
            result.variants.map(({ heapBytes }) => heapBytes),
            [48, 48]
        );
    });

    it('counts no bytes when the run or the runtime does not', async () => {
        const counting = new FakeRuntime();
        const blind = new FakeRuntime({ heap: false });

        const off = await measureGroup(
            { name: 'off', variants: [counting.variant('a', 10, 8)] },
            { ...QUICK, heap: false, runtime: counting }
        );
        const none = await measureGroup(
            { name: 'none', variants: [blind.variant('a', 10, 8)] },
            { ...QUICK, runtime: blind }
        );

        assert.deepEqual(
            [...off.variants, ...none.variants].map(v => v.heapBytes),
            [null, null, null, null]
        );
    });

    describe('lead', () => {
        it('leads with the fastest round for short calls that allocate little', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                { name: 'short', variants: [runtime.variant('a', 999, 1023)] },
                { ...QUICK, runtime }
            );

            assert.deepEqual([result.lead, result.leadReason], ['fastest', 'short calls']);
        });

        it('leads with the median round when a call takes 1 µs or more', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                { name: 'long', variants: [runtime.variant('a', 10), runtime.variant('b', 1000)] },
                { ...QUICK, runtime }
            );

            assert.deepEqual([result.lead, result.leadReason], ['median', 'long calls']);
        });

        it('leads with the median round when a call allocates 1 KiB or more', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                {
                    name: 'allocating',
                    variants: [runtime.variant('a', 10), runtime.variant('b', 10, 1024)]
                },
                { ...QUICK, runtime }
            );

            assert.deepEqual([result.lead, result.leadReason], ['median', 'allocating calls']);
        });

        it('compares the fastest rounds, or the median of the rounds’ ratios, as the group sets', async () => {
            const runtime = new FakeRuntime();
            // Its loops take 100 ns and 300 ns a call, in turn
            let slow = false;
            const alternating: SyncVariant = {
                name: 'alternating',
                setup: () => {
                    slow = !slow;
                },
                run: () => runtime.clock.spend(slow ? 300 : 100)
            };
            const variants = [runtime.variant('steady', 100), alternating];

            const fastest = await measureGroup(
                { name: 'fastest', variants, lead: 'fastest' },
                { ...QUICK, runtime }
            );
            const median = await measureGroup(
                { name: 'median', variants, lead: 'median' },
                { ...QUICK, runtime }
            );

            assert.deepEqual([fastest.lead, fastest.leadReason], ['fastest', 'set']);
            assertClose(variantNamed(fastest, 'alternating').ratio, 1);
            // The slower of the two middle ratios of 1 and 3, half each
            assertClose(variantNamed(median, 'alternating').ratio, 3);

            const { summary, interval } = variantNamed(median, 'alternating');
            assert.ok(summary.modes !== null);
            assert.deepEqual(
                [summary.modes.fast.rounds, summary.modes.slow.rounds],
                [median.rounds / 2, median.rounds / 2]
            );
            assertClose(summary.modes.fast.median, 100);
            assertClose(summary.modes.slow.median, 300);
            assert.ok(interval !== null);
            assertClose(interval[0], 1);
            assertClose(interval[1], 3);
        });
    });
});

describe('measureGroups', () => {
    it('measures the groups that the filter selects, and reports each as it goes', async () => {
        const runtime = new FakeRuntime();
        const groups = ['apple', 'banana', 'blueberry', 'cherry'].map(name => ({
            name,
            variants: [runtime.variant('a', 10)]
        }));
        const reported: string[] = [];

        const result = await measureGroups(groups, {
            ...QUICK,
            // A global expression's test() would skip every other match
            filter: /^b/gu,
            runtime,
            onGroup: group => reported.push(group.name)
        });

        assert.deepEqual(reported, ['banana', 'blueberry']);
        assert.deepEqual(
            result.groups.map(group => group.name),
            ['banana', 'blueberry']
        );
        assert.equal(result.schema, 1);
        assert.equal(result.runtime, runtime.description);
        assert.deepEqual(result.options, {
            rounds: 31,
            warmupRounds: 2,
            sampleTime: 0.01,
            aa: true,
            heap: true,
            filter: '^b'
        });
    });

    it('gives results that JSON keeps as they are', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroups(
            [{ name: 'json', variants: [runtime.variant('a', 10), runtime.asyncVariant('b', 20)] }],
            { ...QUICK, runtime }
        );

        assert.deepEqual(JSON.parse(formatJson(result)), result);
    });
});
