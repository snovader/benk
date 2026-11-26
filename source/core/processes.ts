// The ratios of a benchmark script's runs in several processes, which
// `--processes` makes: each variant's ratio in each process, their median,
// and their range. A process has one set of V8's tiering decisions, one heap
// layout and one order of loading, which all of its rounds share, so a
// variant's interval, of the rounds of one process, can't say how its ratio
// varies between processes.
//
// A process runs the whole script, so there are few of them, and their
// ratios are summarized by their median and range rather than an interval.
// The range of n processes' ratios is the widest interval of their order
// statistics: if the processes are alike and independent, it leaves out the
// median of the ratio's distribution between processes with a chance of
// 2 · 2⁻ⁿ, so it holds it with 75% confidence for 3 processes, 88% for 4,
// and 94% for 5. Two processes' range holds it with 50%, and their median
// would be the greater ratio, so they get none.
import { ratioByLead } from './lead.ts';
import { pairedRatios, quantile, sortedCopy } from './statistics.ts';
import type {
    GroupAcrossProcesses,
    GroupResult,
    Lead,
    Processes,
    ProcessRun,
    RunResult,
    VariantAcrossProcesses
} from './types.ts';

/** The fewest processes whose ratios have a median */
const MEDIAN_PROCESSES = 3;

/**
 * A run's results with those of the script's runs in other processes, after
 * it, and each variant's ratio in every process, with their median, of 3
 * processes or more, and their range. Each ratio is by the statistic that its group leads with in the
 * first process, whose table names it. A process whose group leads with the
 * other statistic, as when its calls ran in another tier, gets the ratio
 * from its rounds, as `measureGroup()` compares them.
 *
 * @throws {Error} If a run's groups, or a group's variants, aren't the
 * first's, by their names and in their order, as when a script measures
 * other groups in another process.
 */
export function withProcesses(
    first: RunResult,
    runs: readonly ProcessRun[]
): RunResult & { readonly processes: Processes } {
    for (const [i, run] of runs.entries()) {
        checkGroups(first.groups, run.groups, i + 2);
    }

    const groups = first.groups.map((group, i) =>
        groupAcrossProcesses([group, ...runs.map(run => run.groups[i])])
    );
    return { ...first, processes: { runs, groups } };
}

/** A group's ratios in each process, by the first process's lead */
function groupAcrossProcesses(
    groups: readonly GroupResult[]
): GroupAcrossProcesses {
    const [{ name, lead, variants }] = groups;

    return {
        name,
        lead,
        leads: groups.map(group => group.lead),
        variants: variants.map((_, i) =>
            variantAcrossProcesses(groups, i, lead)
        )
    };
}

/** The ratios of a group's variant, by its index, in each process */
function variantAcrossProcesses(
    groups: readonly GroupResult[],
    index: number,
    lead: Lead
): VariantAcrossProcesses {
    const { name, role } = groups[0].variants[index];
    const ratios = groups.map(group => ratioIn(group, index, lead));
    const sorted = sortedCopy(ratios);

    return {
        name,
        role,
        ratios,
        intervals: groups.map(group => group.variants[index].interval),
        median:
            sorted.length < MEDIAN_PROCESSES ? null : quantile(sorted, 0.5),
        range: [sorted[0], sorted[sorted.length - 1]]
    };
}

/**
 * A variant's ratio in a process by a lead: its own ratio, where the
 * process's group leads with it, or else from the process's rounds
 */
function ratioIn(group: GroupResult, index: number, lead: Lead): number {
    const variant = group.variants[index];
    if (group.lead === lead || variant.role === 'reference') {
        return variant.ratio;
    }

    const [reference] = group.variants;
    const ratios = pairedRatios(variant.samples, reference.samples);
    ratios.sort();

    return ratioByLead(lead, variant.summary, reference.summary, ratios);
}

/**
 * Checks that a process measured the first's groups, with the same
 * variants, by their names and in their order
 *
 * @throws {Error} If it didn't, naming the first group that differs.
 */
function checkGroups(
    first: readonly GroupResult[],
    other: readonly GroupResult[],
    number: number
): void {
    const expected = first.map(describeGroup);
    const got = other.map(describeGroup);
    const count = Math.max(expected.length, got.length);

    for (let i = 0; i < count; i++) {
        if (expected.at(i) !== got.at(i)) {
            throw new Error(
                `Expected process ${number} to measure the groups of the first, with the same variants, got ${got.at(i) ?? 'no group'} where the first has ${expected.at(i) ?? 'none'}`
            );
        }
    }
}

/** A group's name and its variants' names, as an error names them */
function describeGroup({ name, variants }: GroupResult): string {
    const names = variants.map(variant => JSON.stringify(variant.name));

    return `${JSON.stringify(name)} of ${names.join(', ')}`;
}
