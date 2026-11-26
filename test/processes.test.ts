// The ratios of a run in several processes, as `--processes` records and
// prints them, from runs that the fake runtime measured one after another,
// as processes would. `bench()` runs the processes themselves, as
// `cli.test.ts` tests.
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import {
    formatJson,
    measureGroups,
    type Group,
    type Lead,
    type Processes,
    type ProcessRun,
    type Role,
    type RunResult,
    type SyncVariant,
    type VariantAcrossProcesses
} from 'benk';
import { withProcesses } from '#source/core/processes';
import { formatProcesses } from '#source/core/report';
import { expectClose } from './expectations.ts';
import { FakeRuntime } from './fake-runtime.ts';

const QUICK = { rounds: 6, warmupRounds: 1, sampleTime: 0.01 };

/**
 * A variant whose calls take the next of `times` in each loop of them, so
 * that its rounds differ, and its fastest round from its median
 */
function changing(runtime: FakeRuntime, name: string, times: readonly number[]): SyncVariant {
    let loops = 0;
    let nanoseconds = times[0];

    return {
        name,
        setup: () => {
            nanoseconds = times[loops++ % times.length];
        },
        run: () => {
            runtime.clock.spend(nanoseconds);
        }
    };
}

/** A process's run of a group of `base`, of 50 ns a call, and `other` */
async function measurePair(
    other: (runtime: FakeRuntime) => SyncVariant,
    { name = 'pair', lead }: { name?: string; lead?: Lead } = {}
): Promise<RunResult> {
    const runtime = new FakeRuntime();
    const group: Group = { name, lead, variants: [runtime.variant('base', 50), other(runtime)] };

    return measureGroups([group], { ...QUICK, runtime });
}

/** A process's results, as the first process reads them */
function asRun({ date, groups }: RunResult): ProcessRun {
    return { date, groups };
}

describe('withProcesses', () => {
    it.prop([fc.array(fc.integer({ min: 5, max: 3000 }), { minLength: 1, maxLength: 6 })])(
        "gives each variant's ratio in each process, with their median and range",
        async times => {
            const results: RunResult[] = [];
            for (const nanoseconds of times) {
                results.push(await measurePair(runtime => runtime.variant('other', nanoseconds)));
            }
            const [first, ...others] = results;

            const { processes } = withProcesses(first, others.map(asRun));
            const [group] = processes.groups;
            const [, other, aa] = group.variants;
            const sorted = other.ratios.toSorted((a, b) => a - b);

            expect(processes.runs).toStrictEqual(others.map(asRun));
            expect(group.lead).toBe(first.groups[0].lead);
            expect(group.variants.map(({ name, role }) => [name, role])).toStrictEqual([
                ['base', 'reference'],
                ['other', 'variant'],
                ['base A/A', 'aa']
            ]);
            for (const [i, nanoseconds] of times.entries()) {
                expectClose(other.ratios[i], nanoseconds / 50);
                expectClose(aa.ratios[i], 1);
            }
            expect(other.intervals).toStrictEqual(
                results.map(result => result.groups[0].variants[1].interval)
            );
            // Of an even count, the greater of the middle two
            expect(other.median).toBe(sorted[Math.floor(sorted.length / 2)]);
            expect(other.range).toStrictEqual([sorted[0], sorted.at(-1)]);
        }
    );

    it('gives the reference 1 in each process, without intervals', async () => {
        const first = await measurePair(runtime => runtime.variant('other', 80));
        const second = await measurePair(runtime => runtime.variant('other', 120));

        const [reference] = withProcesses(first, [asRun(second)]).processes.groups[0].variants;

        expect(reference).toStrictEqual({
            name: 'base',
            role: 'reference',
            ratios: [1, 1],
            intervals: [null, null],
            median: 1,
            range: [1, 1]
        });
    });

    it("takes the ratio of a process whose group leads with the other statistic from its rounds, by the first's", async () => {
        const times = [100, 300];
        const first = await measurePair(runtime => changing(runtime, 'other', times), {
            lead: 'fastest'
        });
        const second = await measurePair(runtime => changing(runtime, 'other', times), {
            lead: 'median'
        });
        const [base, other] = second.groups[0].variants;

        const ratios = withProcesses(first, [asRun(second)]).processes.groups[0].variants[1].ratios;

        // Their own ratios differ: by the median, the second's is of the slow rounds
        expect(other.ratio).not.toBeCloseTo(other.summary.fastest / base.summary.fastest);
        expect(ratios).toStrictEqual([
            first.groups[0].variants[1].ratio,
            other.summary.fastest / base.summary.fastest
        ]);
    });

    it('throws for a process that measured other groups, or other variants', async () => {
        const first = await measurePair(runtime => runtime.variant('other', 80));
        const renamed = await measurePair(runtime => runtime.variant('other', 80), {
            name: 'renamed'
        });
        const otherVariant = await measurePair(runtime => runtime.variant('another', 80));
        const groups = '"pair" of "base", "other", "base A/A"';

        expect(() => withProcesses(first, [asRun(first), asRun(renamed)])).toThrow(
            `Expected process 3 to measure the groups of the first, with the same variants, got "renamed" of "base", "other", "base A/A" where the first has ${groups}`
        );
        expect(() => withProcesses(first, [asRun(otherVariant)])).toThrow(
            `got "pair" of "base", "another", "base A/A" where the first has ${groups}`
        );
        expect(() => withProcesses(first, [{ date: first.date, groups: [] }])).toThrow(
            `got no group where the first has ${groups}`
        );
    });

    it('gives results that JSON keeps as they are', async () => {
        const first = await measurePair(runtime => runtime.variant('other', 80));
        const second = await measurePair(runtime => runtime.variant('other', 120));

        const result = withProcesses(first, [asRun(second)]);

        expect(JSON.parse(formatJson(result))).toStrictEqual(result);
    });
});

/**
 * A variant's ratios across processes, with intervals around them, of
 * `spread` either way, but for the reference's, and their median and range
 */
function across(
    name: string,
    role: Role,
    ratios: readonly number[],
    spread = 0.01
): VariantAcrossProcesses {
    const sorted = ratios.toSorted((a, b) => a - b);

    return {
        name,
        role,
        ratios,
        intervals: ratios.map(ratio =>
            role === 'reference' ? null : [ratio * (1 - spread), ratio * (1 + spread)]
        ),
        median: sorted[Math.floor(sorted.length / 2)],
        range: [sorted[0], sorted[sorted.length - 1]]
    };
}

/** A run in as many processes as each variant has ratios, of one group */
function processesOf(
    variants: readonly VariantAcrossProcesses[],
    lead: Lead = 'median'
): Processes {
    const run: ProcessRun = { date: '2026-11-26T00:00:00.000Z', groups: [] };

    return {
        runs: variants[0].ratios.slice(1).map(() => run),
        groups: [{ name: 'sum', lead, variants }]
    };
}

/** The notes below a table, after its rows */
function notesOf(processes: Processes): string[] {
    const lines = formatProcesses(processes);
    // After the paragraph, the table's title and its header
    const rows = 5 + processes.groups[0].variants.length;

    return lines.slice(rows);
}

describe('formatProcesses', () => {
    it("prints a paragraph, and each group's ratios in each process, with their median and range", () => {
        const lines = formatProcesses(
            processesOf(
                [
                    across('for loop', 'reference', [1, 1, 1]),
                    across('reduce', 'variant', [5.09, 4.91, 5.01], 0.05),
                    across('for loop A/A', 'aa', [1, 0.996, 1.02], 0.05)
                ],
                'fastest'
            )
        );

        expect(lines).toStrictEqual([
            '',
            "In 3 processes, the first of them the run above, and the others its repeats: each variant's ratio in each, by the statistic that its group leads with in the first, the median of the 3 ratios, and their range.",
            '',
            'sum: 3 processes, by the fastest round',
            '                         1       2       3   median          range',
            '  for loop           1.00×   1.00×   1.00×    1.00×',
            '  reduce             5.09×   4.91×   5.01×    5.01×      4.91–5.09',
            '  for loop A/A       1.00×   1.00×   1.02×    1.00×      1.00–1.02'
        ]);
    });

    it('notes a variant whose intervals of two processes are apart, naming the furthest apart', () => {
        const apart = across('typed', 'variant', [0.62, 0.91, 0.63, 0.62]);
        const overlapping = across('loop', 'variant', [0.62, 0.63, 0.625], 0.01);
        const aa = across('base A/A', 'aa', [1, 1.05, 0.97], 0.01);

        expect(
            notesOf(processesOf([across('base', 'reference', [1, 1, 1, 1]), apart]))
        ).toStrictEqual([
            "  typed: the intervals of processes 1 and 2 don't overlap, 0.61–0.63 and 0.90–0.92"
        ]);
        expect(
            notesOf(processesOf([across('base', 'reference', [1, 1, 1]), overlapping]))
        ).toStrictEqual([]);
        expect(notesOf(processesOf([across('base', 'reference', [1, 1, 1]), aa]))).toStrictEqual([
            "  base A/A: the intervals of processes 2 and 3 don't overlap, 1.04–1.06 and 0.96–0.98"
        ]);
    });

    it('notes a variant whose ratios lie on both sides of 1, as printed, but not an A/A copy', () => {
        const reference = across('base', 'reference', [1, 1, 1]);
        const wide = 0.2;

        expect(
            notesOf(processesOf([reference, across('reduce', 'variant', [0.95, 1.04, 1.06], wide)]))
        ).toStrictEqual(['  reduce: faster than base in 1 process, and slower in 2']);
        expect(
            notesOf(
                processesOf([reference, across('reduce', 'variant', [0.95, 1.004, 1.06], wide)])
            )
        ).toStrictEqual(['  reduce: faster than base in 1 process, and slower in 1']);
        expect(
            notesOf(processesOf([reference, across('base A/A', 'aa', [0.95, 1.04, 1.06], wide)]))
        ).toStrictEqual([]);
    });

    it("notes a variant whose median is no further from 1 than the A/A copy's ratios", () => {
        const reference = across('base', 'reference', [1, 1, 1]);
        const aa = across('base A/A', 'aa', [0.97, 1, 1.03], 0.05);
        const variant = (ratios: number[]): VariantAcrossProcesses =>
            across('reduce', 'variant', ratios, 0.05);

        expect(notesOf(processesOf([reference, variant([1.02, 1.03, 1.01]), aa]))).toStrictEqual([
            "  reduce: median 1.02×, no further from 1 than the A/A copy's ratios, 0.97–1.03"
        ]);
        // Below 1 by a factor within the A/A copy's reach above it
        expect(notesOf(processesOf([reference, variant([0.975, 0.98, 0.985]), aa]))).toStrictEqual([
            "  reduce: median 0.98×, no further from 1 than the A/A copy's ratios, 0.97–1.03"
        ]);
        // Further from 1
        expect(notesOf(processesOf([reference, variant([1.05, 1.06, 1.04]), aa]))).toStrictEqual(
            []
        );
        // Printed as 1.00, which shows no difference to explain
        expect(notesOf(processesOf([reference, variant([1.004, 1.003, 1.002]), aa]))).toStrictEqual(
            []
        );
        // Without an A/A copy
        expect(notesOf(processesOf([reference, variant([1.02, 1.03, 1.01])]))).toStrictEqual([]);
    });
});
