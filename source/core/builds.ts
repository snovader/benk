// The comparison of two builds of the code that a benchmark script times,
// which `compareBuilds()` makes, to answer whether a change is faster than
// the code that it changes: base, as `main` builds it, and head, as the
// change does.
//
// A build is a module that the user has built, such as the entry of a
// worktree's bundle: benk doesn't know how a project builds or checks out a
// revision. The script makes its groups from a build's module, once for
// each build, and each variant of base is paired with head's variant of the
// same group and name. Each pair is a group of its own, of base as the
// reference, head as the variant, and base's A/A copy, so that a round runs
// the two builds' calls one after another, in an order that rotates, and
// the pair's ratio and interval are of head's time to base's, as any
// group's are.
//
// The builds' modules are files of their own, so they don't share V8's
// compiled code or type feedback. What both builds' calls pass through
// they share: the script's own functions, as the closures that make a
// variant's `run`, and the modules that both builds import.
//
// Which build a process loads first changes in turn between processes:
// V8 can treat the code that it loads and runs first otherwise, as where
// both builds' calls share code whose feedback the first shapes. The
// comparison sets the ratios of the processes that loaded each build first
// against each other.
import { withProcesses } from './processes.ts';
import { quantile, sortedCopy } from './statistics.ts';
import type {
    Build,
    BuildComparison,
    BuildName,
    Difference,
    Group,
    GroupAcrossProcesses,
    GroupsOfBuild,
    LoadOrder,
    RunResult,
    Variant,
    VariantAcrossBuilds
} from './types.ts';

/**
 * The chance, at most, that the ratios of the processes that loaded each
 * build first lie apart by chance, where the order doesn't matter, for
 * `LoadOrder.apart`. Every arrangement of the ratios between the orders is
 * then as likely, and 2 of them put one order's ratios all above the
 * other's. So 4 processes of each order are the fewest, 2 in 70.
 */
const APART_CHANCE = 0.05;

/** A variant of the two builds, which a group of its own pairs */
export interface BuildPair {
    /** The variant's group, by its name in both builds */
    readonly group: string;
    /** The variant, by its name in both builds */
    readonly variant: string;
    /** The pair's group: base's variant, then head's */
    readonly pair: Group;
}

/** Where a comparison's variants came from, beside a run's results */
export interface ComparedBuilds {
    readonly base: Build;
    readonly head: Build;
    /** The build that each process loaded first, from the first */
    readonly loadedFirst: readonly BuildName[];
    /**
     * The group and variant of each of the run's groups, which are pairs,
     * in the same order
     */
    readonly origins: ReadonlyArray<Pick<BuildPair, 'group' | 'variant'>>;
}

/** What a process's comparison of builds measured, beside its results */
export interface Comparison {
    readonly builds: Readonly<Record<BuildName, Build>>;
    /** The build that the process loaded first */
    readonly first: BuildName;
    /** The pairs that it made, as groups */
    readonly pairs: readonly BuildPair[];
}

/**
 * The build that a process loads first, by its number from 1: base in the
 * first, as in each odd-numbered one, and head in each even-numbered one
 */
export function firstBuildIn(process: number): BuildName {
    return process % 2 === 1 ? 'base' : 'head';
}

/** The name of a variant's pair, as a group, as `sum / for loop` */
export function pairName(group: string, variant: string): string {
    return `${group} / ${variant}`;
}

/**
 * Loads both builds, the first one first, and makes each one's groups as
 * soon as it's loaded, and returns each variant's pair, as `pairBuilds()`
 * makes them
 *
 * @throws {TypeError} If both loads give the same module, or the builds'
 * groups don't pair, as `pairBuilds()` describes.
 */
export async function groupsOfBuilds<M>(
    groupsOf: GroupsOfBuild<M>,
    load: (build: BuildName) => Promise<M>,
    first: BuildName
): Promise<BuildPair[]> {
    const order: BuildName[] =
        first === 'base' ? ['base', 'head'] : ['head', 'base'];
    const modules = new Map<BuildName, M>();
    const made = new Map<BuildName, Group[]>();

    for (const build of order) {
        const module = await load(build);
        if (Array.from(modules.values()).some(other => other === module)) {
            throw new TypeError(
                'Expected --base and --head to load two modules, got the same module for both'
            );
        }
        modules.set(build, module);
        made.set(build, Array.from(await groupsOf(module)));
    }

    return pairBuilds(made.get('base') ?? [], made.get('head') ?? []);
}

/**
 * A run's results with the comparison of a process's builds, as
 * `withBuilds()` gives it: in this process, which loaded `first` first, and
 * in the run's processes after it, which loaded builds first in turn, as
 * `firstBuildIn()` says
 */
export function withComparison(
    result: RunResult,
    { builds, first, pairs }: Comparison
): RunResult & { readonly builds: BuildComparison } {
    const others = result.processes?.runs.length ?? 0;
    const origins = new Map(pairs.map(pair => [pair.pair.name, pair]));

    return withBuilds(result, {
        ...builds,
        loadedFirst: [
            first,
            ...Array.from({ length: others }, (_, i) => firstBuildIn(i + 2))
        ],
        // The run measured these pairs, of those that the filter selects
        origins: result.groups.map(
            group =>
                origins.get(group.name) ?? { group: group.name, variant: '' }
        )
    });
}

/**
 * Pairs each variant of base's groups with head's variant of the same group
 * and name, in base's order, each as a group of its own: base's variant,
 * named `base`, as its reference, then head's, named `head`, with base's
 * lead and A/A copy. A pair's variant runs its build's `run` itself, so
 * that the timer loop calls nothing else, and its setup and teardown with
 * their variant as `this`.
 *
 * @throws {TypeError} If a build has two groups of one name, or a group
 * two variants of one name, or none, or the builds' groups or variants
 * differ by name, or a group's lead or A/A copy, or a variant is async in
 * one build only, or has the same `run` in both, which would compare a
 * build with itself.
 */
export function pairBuilds(
    base: readonly Group[],
    head: readonly Group[]
): BuildPair[] {
    checkSameNames(
        base.map(group => group.name),
        head.map(group => group.name),
        'groups'
    );
    const heads = new Map(head.map(group => [group.name, group]));

    return base.flatMap(group => {
        // The names are the same, and each once in each build
        const other = heads.get(group.name) ?? group;
        return pairsOf(group, other);
    });
}

/** The pairs of the variants of a group of each build */
function pairsOf(base: Group, head: Group): BuildPair[] {
    const { name } = base;
    if (base.variants.length === 0) {
        throw new TypeError(`Expected group "${name}" to have variants`);
    }
    if (base.lead !== head.lead || base.aa !== head.aa) {
        throw new TypeError(
            `Expected group "${name}" to set the same lead and aa in both builds, got ${describeSettings(base)} in base and ${describeSettings(head)} in head`
        );
    }
    checkSameNames(
        base.variants.map(variant => variant.name),
        head.variants.map(variant => variant.name),
        `variants of group "${name}"`
    );
    const heads = new Map(
        head.variants.map(variant => [variant.name, variant])
    );

    return base.variants.map(variant => {
        const other = heads.get(variant.name) ?? variant;
        checkPair(name, variant, other);

        return {
            group: name,
            variant: variant.name,
            pair: {
                name: pairName(name, variant.name),
                lead: base.lead,
                aa: base.aa,
                variants: [asBuild(variant, 'base'), asBuild(other, 'head')]
            }
        };
    });
}

/**
 * Checks that both builds made the same groups, or variants of a group, by
 * their names, each once
 *
 * @throws {TypeError} If a name repeats in a build, or only one build has
 * it.
 */
function checkSameNames(
    base: readonly string[],
    head: readonly string[],
    what: string
): void {
    for (const [build, names] of [
        ['base', base],
        ['head', head]
    ] as const) {
        const repeated = names.find((name, i) => names.indexOf(name) !== i);
        if (repeated != null) {
            throw new TypeError(
                `Expected the ${what} of ${build} to have different names, but "${repeated}" repeats`
            );
        }
    }

    const inHead = new Set(head);
    const inBase = new Set(base);
    const onlyBase = base.find(name => !inHead.has(name));
    const onlyHead = head.find(name => !inBase.has(name));
    if (onlyBase != null || onlyHead != null) {
        const [build, only] =
            onlyBase == null ? ['head', onlyHead] : ['base', onlyBase];
        throw new TypeError(
            `Expected both builds to make the same ${what}, but only ${build} made "${only}"`
        );
    }
}

/**
 * Checks that a variant of each build can be compared: both sync or both
 * async, as the awaiting loop costs more, and with a `run` of each build's
 * own
 *
 * @throws {TypeError} If not.
 */
function checkPair(group: string, base: Variant, head: Variant): void {
    const name = `variant "${base.name}" of group "${group}"`;
    if ((base.async === true) !== (head.async === true)) {
        throw new TypeError(
            `Expected the ${name} to be async in both builds or in neither, got ${base.async === true ? 'base' : 'head'} only`
        );
    }
    if (base.run === head.run) {
        throw new TypeError(
            `Expected the ${name} to run each build's own code, but both builds gave it the same run: make the run from the build that the function of groups is given`
        );
    }
}

/** A group's settings that both builds must make alike */
function describeSettings({ lead, aa }: Group): string {
    return `lead ${lead ?? 'auto'} and aa ${aa ?? 'by the run'}`;
}

/**
 * A build's variant, named after the build. Its `run` is the variant's
 * own: a function around it would be another call in each timed one.
 */
function asBuild(variant: Variant, name: BuildName): Variant {
    if (variant.async === true) {
        return {
            name,
            async: true,
            run: variant.run,
            setup: variant.setup && (calls => variant.setup?.(calls)),
            teardown: variant.teardown && (() => variant.teardown?.())
        };
    }

    return {
        name,
        run: variant.run,
        setup: variant.setup && (calls => variant.setup?.(calls)),
        teardown: variant.teardown && (() => variant.teardown?.())
    };
}

/**
 * A run's results with the comparison of its builds: each variant's ratio
 * of head's time to base's in each process, from the run's processes, or
 * from its own groups in one process, what each process's rounds showed of
 * it, their median and range, and the ratios by the build that each
 * process loaded first
 */
export function withBuilds<R extends RunResult>(
    result: R,
    { base, head, loadedFirst, origins }: ComparedBuilds
): R & { readonly builds: BuildComparison } {
    const processes = result.processes ?? withProcesses(result, []).processes;
    const variants = processes.groups.map((group, i) =>
        variantAcrossBuilds(group, origins[i], loadedFirst)
    );

    return { ...result, builds: { base, head, loadedFirst, variants } };
}

/** A pair's ratios of head's time to base's, from the pair's group */
function variantAcrossBuilds(
    { lead, variants }: GroupAcrossProcesses,
    { group, variant }: Pick<BuildPair, 'group' | 'variant'>,
    loadedFirst: readonly BuildName[]
): VariantAcrossBuilds {
    // The pair's group has base's variant, head's, and base's A/A copy
    const head = variants.find(other => other.role === 'variant');
    const aa = variants.find(other => other.role === 'aa');
    const ratios = head?.ratios ?? [];
    const intervals = head?.intervals ?? [];

    return {
        group,
        variant,
        lead,
        ratios,
        intervals,
        aa: aa == null ? null : { ratios: aa.ratios, intervals: aa.intervals },
        differences: intervals.map((interval, i) =>
            differenceOf(interval, aa?.intervals[i] ?? null)
        ),
        median: head?.median ?? null,
        range: head?.range ?? null,
        loadOrder: loadOrderOf(ratios, loadedFirst)
    };
}

/**
 * What a process's rounds showed of head's time against base's: faster or
 * slower where head's interval lies apart from the A/A copy's, or from 1
 * where the A/A copy has none, and within noise where it doesn't. Two 95%
 * intervals that don't overlap differ by more than either's width, so
 * identical code lies apart this way in far fewer than 5% of processes.
 */
function differenceOf(
    interval: readonly [number, number] | null,
    noise: readonly [number, number] | null
): Difference | null {
    if (interval == null) {
        return null;
    }

    const [low, high] = noise ?? [1, 1];
    return interval[1] < low
        ? 'faster'
        : interval[0] > high
          ? 'slower'
          : 'within noise';
}

/** A variant's ratios by the build that each process loaded first */
function loadOrderOf(
    ratios: ReadonlyArray<number | null>,
    loadedFirst: readonly BuildName[]
): LoadOrder {
    const ofOrder = (build: BuildName): Array<number | null> =>
        ratios.filter((_, i) => loadedFirst[i] === build);
    const base = sortedOrNull(ofOrder('base'));
    const head = sortedOrNull(ofOrder('head'));

    return {
        base: base == null ? null : quantile(base, 0.5),
        head: head == null ? null : quantile(head, 0.5),
        apart: base != null && head != null && areApart(base, head)
    };
}

/** Ratios sorted, or null if there are none or any is missing */
function sortedOrNull(
    ratios: ReadonlyArray<number | null>
): Float64Array | null {
    return ratios.length > 0 && ratios.every(ratio => ratio != null)
        ? sortedCopy(ratios)
        : null;
}

/**
 * Whether two sorted sets of ratios lie apart, each above or below every
 * ratio of the other, and are enough processes for that to happen by
 * chance no more often than `APART_CHANCE`
 */
function areApart(base: Float64Array, head: Float64Array): boolean {
    const separated =
        base[base.length - 1] < head[0] || head[head.length - 1] < base[0];

    return (
        separated &&
        2 / arrangements(base.length + head.length, base.length) <= APART_CHANCE
    );
}

/** The ways to choose `k` of `n`, the binomial coefficient */
function arrangements(n: number, k: number): number {
    let ways = 1;
    for (let i = 1; i <= k; i++) {
        ways = (ways * (n - k + i)) / i;
    }

    return ways;
}
