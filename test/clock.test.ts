// The resolution of the runtime's timer loops, which a group's results
// record, and the note of a table whose rounds are too few times it
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import { formatGroup, formatTime, measureGroup, type GroupResult, type Timer } from 'benk';
import { FakeRuntime, type FakeRuntimeOptions } from './fake-runtime.ts';

/** Rounds of 100 µs, few of them */
const QUICK = { sampleTime: 0.1, warmupRounds: 1, rounds: 3, aa: false, heap: false };

/** The note of a table whose rounds are too few times the resolution */
function resolutionNote(lines: readonly string[]): string | undefined {
    return lines.find(line => line.includes(" times the timer's resolution, of "));
}

/** A group's resolution, which a clock that read time for empty calls has */
function resolutionOf({ timerResolution }: GroupResult): number {
    assert.ok(timerResolution !== null, 'Expected a resolution');
    return timerResolution;
}

/** A fake runtime whose clock starts `phase` nanoseconds into a tick */
function startedAt(phase: number, options: FakeRuntimeOptions): FakeRuntime {
    const runtime = new FakeRuntime(options);
    runtime.clock.spend(phase);

    return runtime;
}

describe("the timer's resolution", () => {
    it("records a coarse clock's tick", async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 1, max: 20_000 }), fc.nat(), async (tick, phase) => {
                const runtime = startedAt(phase % tick, { clockTick: tick, heap: false });
                const result = await measureGroup(
                    { name: 'calls', variants: [runtime.variant('a', 50)] },
                    { ...QUICK, runtime }
                );

                const resolution = resolutionOf(result);

                assert.ok(
                    Math.abs(resolution - tick) <= tick * 1e-9,
                    `${resolution} ns for ticks of ${tick} ns`
                );
            })
        );
    });

    it("records a coarse clock's tick when the first loops take several ticks, as cold code does", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 20_000 }),
                fc.nat(),
                fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 3 }),
                async (tick, phase, coldTicks) => {
                    const runtime = startedAt(phase % tick, {
                        clockTick: tick,
                        coldLoops: coldTicks.map(ticks => ticks * tick),
                        heap: false
                    });
                    const result = await measureGroup(
                        { name: 'calls', variants: [runtime.variant('a', 50)] },
                        { ...QUICK, runtime }
                    );
                    const resolution = resolutionOf(result);

                    assert.ok(
                        Math.abs(resolution - tick) <= tick * 1e-9,
                        `${resolution} ns for ticks of ${tick} ns`
                    );
                }
            )
        );
    });

    it("records the time of an empty call where it's longer than the clock's tick", async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async emptyCall => {
                const runtime = new FakeRuntime({ emptyCall, heap: false });
                const result = await measureGroup(
                    { name: 'calls', variants: [runtime.variant('a', 50)] },
                    { ...QUICK, runtime }
                );

                const resolution = resolutionOf(result);

                assert.ok(
                    Math.abs(resolution - emptyCall) <= emptyCall * 1e-6,
                    `${resolution} ns for empty calls of ${emptyCall} ns`
                );
            })
        );
    });

    it('notes rounds of fewer than 50 ticks, with the sample time that gives 50', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 20_000 }),
                fc.integer({ min: 10, max: 500 }),
                fc.nat(),
                async (tick, call, phase) => {
                    const runtime = startedAt(phase % tick, { clockTick: tick, heap: false });
                    const result = await measureGroup(
                        { name: 'calls', variants: [runtime.variant('a', call)] },
                        { ...QUICK, runtime }
                    );
                    // A round's reading is off by less than a tick, so its
                    // ticks are those of its calls' time, give or take one
                    const ticks = (result.variants[0].repetitions * call) / tick;
                    const note = resolutionNote(formatGroup(result));

                    if (ticks < 48) {
                        assert.ok(note !== undefined, `no note at ${ticks} ticks a round`);
                        // Of the recorded tick, which a float's rounding can take a hair
                        // under the clock's, and a time such as 152.5 µs to 152
                        const sampleTime = formatTime(50 * resolutionOf(result));
                        assert.ok(
                            note.endsWith(`a sample time of ${sampleTime} or more gives 50`),
                            note
                        );
                    } else if (ticks > 52) {
                        assert.equal(note, undefined, `a note at ${ticks} ticks a round`);
                    }
                }
            )
        );
    });

    it('takes one timer loop of a runtime to time its clock, the first time only', async () => {
        class CountingRuntime extends FakeRuntime {
            loops = 0;

            override createTimer(): Timer {
                this.loops++;
                return super.createTimer();
            }
        }

        const runtime = new CountingRuntime({ heap: false });
        const group = { name: 'calls', variants: [runtime.variant('a', 50)] };
        await measureGroup(group, { ...QUICK, aa: true, runtime });
        await measureGroup(group, { ...QUICK, aa: true, runtime });

        // Each group's variant and its A/A copy, and the clock's once
        assert.equal(runtime.loops, 5);
    });

    it("measures with a clock that only a variant's calls move, without a resolution", async () => {
        const runtime = new FakeRuntime({ emptyCall: 0, heap: false });
        const result = await measureGroup(
            { name: 'calls', variants: [runtime.variant('a', 100)] },
            { ...QUICK, runtime }
        );

        assert.equal(result.timerResolution, null);
        assert.ok(Math.abs(result.variants[0].summary.median - 100) < 1e-9);
        assert.equal(resolutionNote(formatGroup(result)), undefined);
    });

    it("rejects when the clock reads no time for empty calls, nor for a variant's", async () => {
        class FrozenRuntime extends FakeRuntime {
            override createTimer(): Timer {
                return () => 0;
            }
        }

        const runtime = new FrozenRuntime({ heap: false });
        await assert.rejects(
            measureGroup(
                { name: 'calls', variants: [{ name: 'a', run: () => 1 }] },
                { ...QUICK, runtime }
            ),
            {
                name: 'Error',
                message:
                    'Expected the runtime\'s clock to advance, but it read no time for empty calls, nor for 1,048,576 calls of Variant "a" of group "calls"'
            }
        );
    });
});
