import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { formatJson, measureGroup, measureGroups, type GroupResult, type SyncVariant } from 'benk';
import { expectClose, expectPresent } from './expectations.ts';
import { FakeRuntime } from './fake-runtime.ts';

/** Options that keep the fake loops short: about 200 calls of 50 ns a round */
const QUICK = { sampleTime: 0.01, warmupRounds: 2 };

function variantNamed(result: GroupResult, name: string): GroupResult['variants'][number] {
    const variant = result.variants.find(v => v.name === name);

    return expectPresent(variant, `no variant named ${name}`);
}

describe('measureGroup', () => {
    it('times each variant per call, and compares it with the first', async () => {
        const runtime = new FakeRuntime();
        const result = await measureGroup(
            { name: 'calls', variants: [runtime.variant('a', 50), runtime.variant('b', 100)] },
            { ...QUICK, runtime }
        );

        expect(result.variants.map(({ name, role }) => [name, role])).toStrictEqual([
            ['a', 'reference'],
            ['b', 'variant'],
            ['a A/A', 'aa']
        ]);
        for (const [name, time, ratio] of [
            ['a', 50, 1],
            ['b', 100, 2],
            ['a A/A', 50, 1]
        ] as const) {
            const { summary, samples } = variantNamed(result, name);
            expect(samples).toHaveLength(result.rounds);
            expectClose(summary.fastest, time);
            expectClose(summary.median, time);
            expectClose(variantNamed(result, name).ratio, ratio);
        }

        const interval = expectPresent(variantNamed(result, 'b').interval);
        expectClose(interval[0], 2);
        expectClose(interval[1], 2);
        expect(variantNamed(result, 'a').interval).toBeNull();
    });

    it.prop([fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 40 }), fc.boolean()], {
        numRuns: 40
    })(
        'takes every variant through every position equally often, in whole rotations',
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

            expect(result.variants).toHaveLength(total);
            expect(result.rounds).toBeGreaterThanOrEqual(rounds);
            expect(result.rounds).toBeLessThan(rounds + 2 * total);
            for (const { positions } of result.variants) {
                const counts = new Array<number>(total).fill(0);
                for (const position of positions) {
                    counts[position]++;
                }
                expect(counts).toStrictEqual(new Array<number>(total).fill(result.rounds / total));
            }
        }
    );

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

        expect(
            [off, groupOff, groupOn].map(result => result.variants.map(v => v.name))
        ).toStrictEqual([['a'], ['a'], ['a', 'a A/A']]);
    });

    it('runs setup before and teardown after each loop, untimed, with its calls', async () => {
        const runtime = new FakeRuntime();
        let inputs: number[] = [];
        let tornDown = true;
        const variant: SyncVariant = {
            name: 'consumes inputs',
            setup: calls => {
                expect(tornDown, 'setup again before teardown').toBe(true);
                tornDown = false;
                // Slow, but untimed
                runtime.clock.spend(1e9);
                inputs = new Array<number>(calls).fill(25);
            },
            run: () => {
                const input = expectPresent(inputs.pop(), 'more calls than setup prepared');
                runtime.clock.spend(input);
            },
            teardown: () => {
                expect(inputs, 'fewer calls than setup prepared').toStrictEqual([]);
                tornDown = true;
            }
        };

        const result = await measureGroup(
            { name: 'setup', variants: [variant] },
            { ...QUICK, runtime }
        );

        for (const { summary } of result.variants) {
            expectClose(summary.fastest, 25);
            expectClose(summary.slowest, 25);
        }
        expect(tornDown).toBe(true);
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
        expect(async.async).toBe(true);
        expect(variantNamed(result, 'sync').async).toBe(false);
        expectClose(async.summary.median, 120);
        expectClose(async.ratio, 3);
        expect(pending).toBe(0);
    });

    it('counts the calls again by doubling them when a warm-up round reads as no time', async () => {
        // Two slow first calls, so that calibration counts 3 calls a round,
        // whose 60 ns a clock of 100 ns ticks reads as none in some rounds
        const runtime = new FakeRuntime({ clockTick: 100 });
        let calls = 0;
        const warms: SyncVariant = {
            name: 'warms',
            run: () => {
                runtime.clock.spend(calls++ < 2 ? 300_000 : 20);
            }
        };

        const result = await measureGroup(
            { name: 'group', aa: false, variants: [warms] },
            { sampleTime: 1, warmupRounds: 3, rounds: 2, runtime }
        );
        const [{ repetitions }] = result.variants;

        // 1 ms of calls of 20 ns, give or take the clock's ticks
        expect(Math.abs(repetitions - 50_000), `${repetitions} calls a round`).toBeLessThan(500);
    });

    it('calls run as a function of its own, without the variant as this', async () => {
        const runtime = new FakeRuntime();
        const receivers = new Set<unknown>();
        const method: SyncVariant = {
            name: 'method',
            run(this: unknown) {
                receivers.add(this);
                runtime.clock.spend(50);
            }
        };

        await measureGroup({ name: 'group', variants: [method] }, { ...QUICK, runtime });

        expect([...receivers]).toStrictEqual([undefined]);
    });

    it('rejects a sync variant whose call returns a promise', async () => {
        const runtime = new FakeRuntime();
        const measurement = measureGroup(
            {
                name: 'group',
                variants: [{ name: 'unmarked', run: () => Promise.reject(new Error('x')) }]
            },
            { ...QUICK, runtime }
        );

        await expect(measurement).rejects.toThrow(TypeError);
        await expect(measurement).rejects.toThrow(/"unmarked" of group "group" returned a promise/);
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

        const measurement = measureGroup(
            { name: 'group', variants: [throwsLater] },
            { ...QUICK, runtime }
        );

        await expect(measurement).rejects.toThrow(/"throws" of group "group" threw/);
        // The error itself, rather than one that equals it
        await expect(measurement).rejects.toSatisfy((error: Error) => error.cause === cause);
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
            await expect(measureGroup(group, { ...options, runtime })).rejects.toThrow(RangeError);
        }
    });

    it('rejects a group without variants, or with two of the same name', async () => {
        const runtime = new FakeRuntime();
        const a = runtime.variant('a', 10);

        const empty = measureGroup({ name: 'empty', variants: [] }, { runtime });
        const twice = measureGroup({ name: 'twice', variants: [a, a] }, { runtime });
        const copied = measureGroup(
            { name: 'A/A', variants: [a, runtime.variant('a A/A', 10)] },
            { runtime }
        );

        await expect(empty).rejects.toThrow(TypeError);
        await expect(twice).rejects.toThrow(TypeError);
        await expect(copied).rejects.toThrow(TypeError);

        const named = await measureGroup(
            { name: 'A/A', variants: [a, runtime.variant('a A/A', 10)] },
            { ...QUICK, aa: false, runtime }
        );
        expect(named.variants).toHaveLength(2);
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

        expect(result.variants.map(({ name, heapBytes }) => [name, heapBytes])).toStrictEqual([
            ['none', 0],
            ['some', 48],
            ['async', 24],
            ['none A/A', 0]
        ]);
    });

    it('counts the median sample, which a sample counting too few or too many bytes leaves alone', async () => {
        // In any 5 samples in a row, one counts a megabyte too few, and one
        // 300 KB too many
        const runtime = new FakeRuntime({ heapErrors: [0, -1e6, 0, 3e5, 0] });
        const result = await measureGroup(
            { name: 'heap', variants: [runtime.variant('some', 50, 48)] },
            { ...QUICK, runtime }
        );

        expect(result.variants.map(({ heapBytes }) => heapBytes)).toStrictEqual([48, 48]);
    });

    it('counts no bytes when the run or the runtime does not', async () => {
        const counting = new FakeRuntime();
        const blind = new FakeRuntime({ heap: false, arrayBuffers: false });

        const off = await measureGroup(
            { name: 'off', variants: [counting.variant('a', 10, 8, 2048)] },
            { ...QUICK, heap: false, runtime: counting }
        );
        const none = await measureGroup(
            { name: 'none', variants: [blind.variant('a', 10, 8, 2048)] },
            { ...QUICK, runtime: blind }
        );

        expect(
            [...off.variants, ...none.variants].map(v => [v.heapBytes, v.arrayBufferBytes])
        ).toStrictEqual([
            [null, null],
            [null, null],
            [null, null],
            [null, null]
        ]);
    });

    describe('array buffers', () => {
        it('counts the bytes of array buffers that a call allocates, apart from its heap bytes', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                {
                    name: 'buffers',
                    variants: [
                        runtime.variant('none', 50),
                        runtime.variant('heap', 50, 48),
                        runtime.variant('buffers', 50, 0, 1024),
                        runtime.variant('both', 50, 200, 8192),
                        runtime.asyncVariant('async', 50, 24, 128)
                    ]
                },
                { ...QUICK, runtime }
            );

            expect(
                result.variants.map(v => [v.name, v.heapBytes, v.arrayBufferBytes])
            ).toStrictEqual([
                ['none', 0, 0],
                ['heap', 48, 0],
                ['buffers', 0, 1024],
                ['both', 200, 8192],
                ['async', 24, 128],
                ['none A/A', 0, 0]
            ]);
        });

        it.prop([fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 0, max: 30 })], {
            numRuns: 40
        })(
            'halves the calls of a sample until one starts no garbage collection',
            async (bytes, calls) => {
                // A sample of more than `calls` calls starts a collection
                const runtime = new FakeRuntime({
                    heap: false,
                    bufferCollectedAbove: bytes * calls
                });
                const result = await measureGroup(
                    { name: 'collected', variants: [runtime.variant('a', 50, 0, bytes)] },
                    { ...QUICK, aa: false, runtime }
                );

                // Each call starts one when the limit is under a call's bytes
                expect(result.variants[0].arrayBufferBytes).toBe(calls === 0 ? null : bytes);
            }
        );

        it.prop(
            [
                fc.integer({ min: 0, max: 1e5 }),
                fc.array(fc.integer({ min: 1, max: 1e9 }), { minLength: 0, maxLength: 2 }),
                fc.nat({ max: 4 })
            ],
            { numRuns: 60 }
        )(
            'counts the median sample, which buffers freed in 2 samples of 5 leave alone',
            async (bytes, frees, at) => {
                // Up to 2 samples of each 5 in a row see buffers freed in the
                // background, which take their count down, or below 0
                const bufferFrees = [...frees, 0, 0, 0, 0, 0].slice(0, 5);
                const rotated = [...bufferFrees.slice(at), ...bufferFrees.slice(0, at)];
                const runtime = new FakeRuntime({ heap: false, bufferFrees: rotated });
                const result = await measureGroup(
                    { name: 'freed', variants: [runtime.variant('a', 50, 0, bytes)] },
                    { ...QUICK, aa: false, runtime }
                );

                expect(result.variants[0].arrayBufferBytes).toBe(bytes);
            }
        );
    });

    describe('lead', () => {
        it('leads with the fastest round for short calls that allocate little', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                { name: 'short', variants: [runtime.variant('a', 999, 1023)] },
                { ...QUICK, runtime }
            );

            expect([result.lead, result.leadReason]).toStrictEqual(['fastest', 'short calls']);
        });

        it('leads with the median round when a call takes 1 µs or more', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                { name: 'long', variants: [runtime.variant('a', 10), runtime.variant('b', 1000)] },
                { ...QUICK, runtime }
            );

            expect([result.lead, result.leadReason]).toStrictEqual(['median', 'long calls']);
        });

        it.prop([fc.integer({ min: 0, max: 2048 }), fc.integer({ min: 0, max: 2048 })], {
            numRuns: 40
        })(
            'leads with the median round when a call allocates 1 KiB or more on the heap and in array buffers together',
            async (heap, buffers) => {
                const runtime = new FakeRuntime();
                const result = await measureGroup(
                    {
                        name: 'allocating',
                        variants: [
                            runtime.variant('a', 10),
                            runtime.variant('b', 10, heap, buffers)
                        ]
                    },
                    { ...QUICK, runtime }
                );

                expect([result.lead, result.leadReason]).toStrictEqual(
                    heap + buffers >= 1024
                        ? ['median', 'allocating calls']
                        : ['fastest', 'short calls']
                );
            }
        );

        it('leads with the median round when a call allocates 1 KiB or more', async () => {
            const runtime = new FakeRuntime();
            const result = await measureGroup(
                {
                    name: 'allocating',
                    variants: [runtime.variant('a', 10), runtime.variant('b', 10, 1024)]
                },
                { ...QUICK, runtime }
            );

            expect([result.lead, result.leadReason]).toStrictEqual(['median', 'allocating calls']);
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

            expect([fastest.lead, fastest.leadReason]).toStrictEqual(['fastest', 'set']);
            expectClose(variantNamed(fastest, 'alternating').ratio, 1);
            // The slower of the two middle ratios of 1 and 3, half each
            expectClose(variantNamed(median, 'alternating').ratio, 3);

            const alternated = variantNamed(median, 'alternating');
            const modes = expectPresent(alternated.summary.modes);
            const interval = expectPresent(alternated.interval);

            expect([modes.fast.rounds, modes.slow.rounds]).toStrictEqual([
                median.rounds / 2,
                median.rounds / 2
            ]);
            expectClose(modes.fast.median, 100);
            expectClose(modes.slow.median, 300);
            expectClose(interval[0], 1);
            expectClose(interval[1], 3);
        });
    });
});

describe('measureGroups', () => {
    it.prop([fc.integer({ min: 4, max: 28 }), fc.boolean()], { numRuns: 30 })(
        "records where a variant's calls changed, in the rounds' order",
        async (changedAfter, faster) => {
            const runtime = new FakeRuntime({ heap: false });
            const [first, rest] = faster ? [300, 100] : [100, 300];
            // Each timed loop's calls take up to 0.5% longer, in an order that
            // neither rises nor falls, as the rounding of the fake clock's
            // sums would otherwise order rounds of the same time by when
            // they ran. A loop next to the change takes the middle time.
            const changeAt = changedAfter + 1;
            let timed = false;
            let timedLoops = 0;
            let time = first;
            const changing: SyncVariant = {
                name: 'changing',
                setup: () => {
                    timedLoops += timed ? 1 : 0;
                    const edge = [1, changedAfter, changeAt, 32].includes(timedLoops);
                    const jitter = edge ? 5 : (7 * timedLoops) % 11;
                    time = (timedLoops < changeAt ? first : rest) * (1 + (0.005 * jitter) / 10);
                },
                run: () => runtime.clock.spend(time)
            };

            const result = await measureGroups(
                [
                    {
                        name: 'change',
                        variants: [runtime.variant('steady', 100), changing],
                        aa: false
                    }
                ],
                {
                    ...QUICK,
                    runtime,
                    onRounds: (_, rounds) => {
                        timed = rounds === 'timed';
                    }
                }
            );
            const [group] = result.groups;
            const change = expectPresent(variantNamed(group, 'changing').change);

            expect(group.rounds).toBe(32);
            expect(variantNamed(group, 'steady').change).toBeNull();
            expect([change.before.rounds, change.after.rounds]).toStrictEqual([
                changedAfter,
                32 - changedAfter
            ]);
            expect(change.before.median / first).toBeGreaterThanOrEqual(1 - 1e-9);
            expect(change.before.median / first).toBeLessThanOrEqual(1.005);
            expect(change.after.median / rest).toBeGreaterThanOrEqual(1 - 1e-9);
            expect(change.after.median / rest).toBeLessThanOrEqual(1.005);
        }
    );

    it.prop([fc.integer({ min: 2, max: 4 }), fc.nat(), fc.boolean()], { numRuns: 20 })(
        'records a variant whose rounds in one position took longer or shorter',
        async (count, which, slower) => {
            const runtime = new FakeRuntime({ heap: false });
            // With the A/A copy, each round runs this many loops, one in each
            // position, in order
            const total = count + 1;
            const position = which % total;
            const sensitiveTime = slower ? 200 : 50;
            let timed = false;
            let timedLoops = 0;
            let time = 100;
            const counted = (name: string, onSetup: () => void): SyncVariant => ({
                name,
                setup: () => {
                    timedLoops += timed ? 1 : 0;
                    onSetup();
                },
                run: () => runtime.clock.spend(time)
            });
            const steady = (): void => {
                time = 100;
            };
            const variants = [
                counted('reference', steady),
                counted('sensitive', () => {
                    time = timed && (timedLoops - 1) % total === position ? sensitiveTime : 100;
                }),
                ...Array.from({ length: count - 2 }, (_, i) => counted(`other ${i}`, steady))
            ];

            const result = await measureGroups([{ name: 'positions', variants }], {
                ...QUICK,
                runtime,
                onRounds: (_, rounds) => {
                    timed = rounds === 'timed';
                }
            });
            const [group] = result.groups;
            const effect = expectPresent(variantNamed(group, 'sensitive').positionEffect);

            expect(effect.position).toBe(position);
            expectClose(effect.median, sensitiveTime);
            expectClose(effect.others, 100);
            for (const variant of group.variants) {
                if (variant.name !== 'sensitive') {
                    expect(variant.positionEffect, variant.name).toBeNull();
                }
            }
        }
    );

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
            filter: /^b/g,
            runtime,
            onGroup: group => reported.push(group.name)
        });

        expect(reported).toStrictEqual(['banana', 'blueberry']);
        expect(result.groups.map(group => group.name)).toStrictEqual(['banana', 'blueberry']);
        expect(result.schema).toBe(5);
        expect(result.v8Report).toBeNull();
        expect(result.runtime).toBe(runtime.description);
        expect(result.options).toStrictEqual({
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

        expect(JSON.parse(formatJson(result))).toStrictEqual(result);
    });
});
