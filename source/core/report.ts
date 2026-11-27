import { ALLOCATING_CALL, LONG_CALL } from './lead.ts';
import { modesAreOf } from './statistics.ts';
import type {
    BuildComparison,
    BuildName,
    Change,
    Difference,
    GroupAcrossProcesses,
    GroupResult,
    Lead,
    LeadReason,
    Processes,
    RecordedOptions,
    RuntimeDescription,
    SharedChange,
    VariantAcrossBuilds,
    VariantAcrossProcesses,
    VariantResult
} from './types.ts';

/** The columns of a group's table after the name, and their widths */
const COLUMNS: ReadonlyArray<readonly [title: string, width: number]> = [
    ['fastest', 11],
    ['median', 11],
    ['spread', 9],
    ['ratio', 9],
    ['95% interval', 15],
    ['heap', 12],
    ['buffers', 12]
];

/** The narrowest column of names */
const NAME_WIDTH = 16;

/**
 * How far outside its interval a ratio by the fastest round needs to be, at
 * least, as a share of the interval's nearer end, for a note. The two are
 * different statistics, so they often differ a little: in 16 runs of
 * two benchmarks of calls of a few nanoseconds, on an Apple M2 Pro with a
 * load average near 7, 25 of 80 ratios were outside their interval as
 * printed, 4 of them of A/A copies. 13 of the 25 were within 5% of it. Of
 * the 12 beyond, 8 were of one variant whose fastest round took half the
 * time of its median, and 2 of the A/A copy of an allocating call.
 */
const OUTSIDE_MARGIN = 0.05;

/**
 * The fewest times the timer's resolution that a median round takes without
 * a note. A round's reading is off by less than a tick of the clock either
 * way, so a ratio can be off by about one over the ticks of a round. Against a fake clock, with
 * rounds of 10 µs and calls of 37 ns to 96 ns, ratios were at most 1.5% from
 * the true ones at 50 ticks a round, and 4.9% at 20. In Node 26.13.0 on an
 * Apple M2 Pro, with rounds of 1 ms and `performance.now()` floored, A/A
 * ratios were within 0.8% of 1 at 50 ticks, and up to 7.1% off at 20.
 */
const ROUND_TICKS = 50;

const LONG = `${LONG_CALL / 1000} µs`;
const ALLOCATING = `${ALLOCATING_CALL / 1024} KiB`;

const LEAD_REASONS: Readonly<Record<LeadReason, string>> = {
    set: 'as the group sets',
    'short calls': `every call under ${LONG} and ${ALLOCATING}`,
    'long calls': `a call of ${LONG} or more`,
    'allocating calls': `a call allocating ${ALLOCATING} or more`
};

/**
 * A paragraph that describes the runtime and what each row of a run's tables
 * reports
 */
export function describeRun(
    runtime: RuntimeDescription,
    { rounds, warmupRounds, sampleTime, heap }: RecordedOptions
): string {
    const flags =
        runtime.flags.length > 0 ? `, with ${runtime.flags.join(' ')}` : '';
    const state =
        runtime.processState.length > 0
            ? ` Process state: ${runtime.processState.join(', ')}.`
            : '';

    return [
        `${runtime.name} ${runtime.version}, ${runtime.engine}, ${runtime.platform} ${runtime.arch}, ${runtime.cpu}${flags}.${state}`,
        `Per call, of at least ${rounds} interleaved rounds of ${sampleTime} ms per variant after ${warmupRounds} warm-up rounds, in an order that rotates each variant through each position:`,
        "the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios" +
            (heap
                ? ', and the bytes allocated on the heap and in array buffers outside it.'
                : '.')
    ].join('\n');
}

/**
 * A group's table: its name and lead, a row for each variant, a note if its
 * rounds are few times the timer's resolution, a note for each variant whose
 * rounds changed partway or else form two modes, one for each whose time
 * depends on its position in the round, and one for each whose ratio by the
 * fastest round lies outside its interval
 */
export function formatGroup({
    name,
    lead,
    leadReason,
    rounds,
    timerResolution,
    change,
    variants
}: GroupResult): string[] {
    const nameWidth = Math.max(
        NAME_WIDTH,
        ...variants.map(variant => variant.name.length)
    );
    const header = `  ${''.padEnd(nameWidth)}${COLUMNS.map(([title, width]) => title.padStart(width)).join('')}`;

    return [
        '',
        `${name}: ${rounds} rounds, by the ${lead === 'fastest' ? 'fastest' : 'median'} round (${LEAD_REASONS[leadReason]})`,
        header,
        ...variants.map(variant => formatRow(variant, nameWidth)),
        ...formatResolution(timerResolution, variants),
        ...formatSharedChange(change, variants),
        ...variants.flatMap((variant, i) => formatRounds(variant, i, change)),
        ...variants.flatMap(variant => formatPositionEffect(variant, variants)),
        ...(lead === 'fastest' ? variants.flatMap(formatOutside) : [])
    ];
}

/**
 * A variant's row. A count of bytes that the run didn't make prints as –,
 * as do the bytes of array buffers in results that a version before
 * `schema` 3 wrote, which have none.
 */
function formatRow(variant: VariantResult, nameWidth: number): string {
    const { summary, ratio, interval, heapBytes, arrayBufferBytes } = variant;
    const cells = [
        formatTime(summary.fastest),
        formatTime(summary.median),
        `${(summary.spread * 100).toFixed(1)}%`,
        formatRatioCell(ratio),
        interval == null
            ? ''
            : `${formatRatio(interval[0])}–${formatRatio(interval[1])}`,
        heapBytes == null ? '–' : formatBytes(heapBytes),
        arrayBufferBytes == null ? '–' : formatBytes(arrayBufferBytes)
    ];

    return `  ${variant.name.padEnd(nameWidth)}${cells.map((cell, i) => padCell(cell, COLUMNS[i][1])).join('')}`;
}

/** The gap that a cell keeps from the one before it, however wide it is */
const GAP = ' ';

/**
 * A cell at the end of its column. One wider than the column, such as the
 * interval of a ratio under 0.01, takes the room it needs after the gap,
 * rather than touching the cell before it.
 */
function padCell(cell: string, width: number): string {
    return GAP + cell.padStart(width - GAP.length);
}

/**
 * A note for a group whose median rounds take less than `ROUND_TICKS` times
 * the timer's resolution, with the sample time that would make the shortest
 * of them take that. The median round counts, as the fastest round of a
 * coarse clock is the one that read a tick less.
 *
 * There's no note without a resolution: where the clock read no time for
 * empty calls, and in results that a version before `schema` 2 wrote, which
 * have none.
 */
function formatResolution(
    resolution: number | null | undefined,
    variants: readonly VariantResult[]
): string[] {
    if (resolution == null) {
        return [];
    }

    let shortest = Infinity;
    for (const { summary, repetitions } of variants) {
        shortest = Math.min(shortest, summary.median * repetitions);
    }

    const times = Math.round(shortest / resolution);
    if (times >= ROUND_TICKS) {
        return [];
    }

    return [
        `  median rounds are as short as ${times} times the timer's resolution, of ${formatTime(resolution)}: a sample time of ${formatTime(ROUND_TICKS * resolution)} or more gives ${ROUND_TICKS}`
    ];
}

/**
 * A note of how a variant's rounds differ: a change partway, or else two
 * modes. A change takes the modes' place, as its rounds before and after it
 * are apart by more than their spread too, and it says when each ran.
 * Results that a version before `schema` 7 wrote have no change, and get the
 * modes' note.
 */
function formatRounds(
    variant: VariantResult,
    index: number,
    shared: SharedChange | null | undefined
): string[] {
    if (variant.change != null) {
        return formatChange(variant.name, variant.change);
    }

    // The group's note, or the position's, says it, once
    return modesByShared(variant, index, shared) || modesByPosition(variant)
        ? []
        : formatModes(variant);
}

/**
 * Whether a variant's two modes are its rounds before and after a step that
 * it shares with others, which the group's note then explains
 */
function modesByShared(
    { samples, summary: { modes } }: VariantResult,
    index: number,
    shared: SharedChange | null | undefined
): boolean {
    return (
        modes != null &&
        shared?.shape === 'step' &&
        shared.variants.includes(index) &&
        modesAreOf(samples, modes, round => round < shared.before.rounds)
    );
}

/**
 * Whether a variant's two modes are the rounds of its position effect and
 * the others, which the position's note then explains
 */
function modesByPosition({
    samples,
    positions,
    summary: { modes },
    positionEffect
}: VariantResult): boolean {
    return (
        modes != null &&
        positionEffect != null &&
        modesAreOf(
            samples,
            modes,
            round => positions[round] === positionEffect.position
        )
    );
}

/**
 * A note for a variant whose rounds changed partway, against the others',
 * and what to do about it, which follows from how they changed:
 *
 * - A step to faster rounds, as when V8's optimized code takes over: as
 *   many more warm-up rounds as ran before it would leave the slower ones
 *   out.
 * - A step to slower rounds, as when its code deoptimized: V8's report
 *   shows whether it did, and another run whether it repeats.
 * - A drift, which no count of warm-up rounds leaves out: its median is of
 *   the middle rounds, and another run shows whether it repeats.
 *
 * A step names its shorter part first. Results that a version before
 * `schema` 7 wrote have no shape, and read as a step.
 */
function formatChange(
    name: string,
    { shape, before, after }: Change
): string[] {
    if (shape === 'drift') {
        const how = after.median > before.median ? 'slowed' : 'sped up';
        return [
            `  ${name}: its rounds ${how} steadily, from near ${formatTime(before.median)} in the first ${before.rounds} to near ${formatTime(after.median)} in the last ${after.rounds}: its median is of the middle rounds, and another run shows whether that repeats`
        ];
    }

    const parts =
        before.rounds <= after.rounds
            ? `the first ${before.rounds} rounds ran near ${formatTime(before.median)}, and the other ${after.rounds} near ${formatTime(after.median)}`
            : `the last ${after.rounds} rounds ran near ${formatTime(after.median)}, and the other ${before.rounds} near ${formatTime(before.median)}`;
    const advice =
        after.median < before.median
            ? `${before.rounds} more warm-up rounds would leave the slower ones out`
            : "another run shows whether that repeats, and V8's report whether its code deoptimized";

    return [`  ${name}: ${parts}: ${advice}`];
}

/**
 * A note for a change that several variants' rounds share, in the same
 * rounds, which names them, unless every variant does. Each round runs
 * every variant, so the ratios of a round compare variants that it changed
 * alike, and hold between those that share it. Load from other processes
 * changes every variant, so it's a cause only where all of them changed.
 * Otherwise, and as well, it's code that all of them run, as a variant and
 * its A/A copy do, which V8 tiers up or that slows down. A step to faster
 * rounds leaves the times of the slower ones, which more warm-up rounds
 * would leave out.
 */
function formatSharedChange(
    change: SharedChange | null | undefined,
    variants: readonly VariantResult[]
): string[] {
    if (change == null) {
        return [];
    }

    const { shape, before, after } = change;
    const every = change.variants.length === variants.length;
    const names = change.variants.map(index => variants[index].name);
    const subject = every ? 'every variant' : formatNames(names);
    const hold = every
        ? "the ratios hold, as each round's variants ran alike"
        : 'the ratios between them hold';
    const slower = after.factor > before.factor;

    if (shape === 'drift') {
        const how = slower ? 'slowed' : 'sped up';
        const cause = every
            ? `as when load from other processes ${slower ? 'rises' : 'falls'}, or code that all of them run changes`
            : 'as when code that all of them run changes';
        return [
            `  the rounds of ${subject} ${how} alike, by ${formatRatio(after.factor / before.factor)}× from the first ${before.rounds} to the last ${after.rounds}, ${cause}: ${hold}`
        ];
    }

    const [shorter, longer, which] =
        before.rounds <= after.rounds
            ? [before, after, 'first']
            : [after, before, 'last'];
    const parts = `the ${which} ${shorter.rounds} rounds of ${subject} took ${formatRatio(shorter.factor / longer.factor)}× as long as the other ${longer.rounds}`;
    const ending = slower
        ? `${every ? 'as when load from other processes starts, or' : 'as when'} code that all of them run slows down: ${hold}, and another run shows whether that repeats`
        : `${every ? 'as when load from other processes stops, or' : 'as when'} V8's code takes over in all of them: ${hold}, and ${before.rounds} more warm-up rounds would leave the slower ones out of the times`;

    return [`  ${parts}, ${ending}`];
}

/** Names as a sentence lists them: `a`, `a and b`, or `a, b and c` */
function formatNames(names: readonly string[]): string {
    return names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A note for a variant whose rounds in one position took longer or shorter
 * than its others, which names what ran just before it there, and how to
 * tell whether that's the cause. It takes the place of the note of two
 * modes, where the modes are the position's rounds and the others. Results
 * that a version before `schema` 7 wrote have no position effect.
 */
function formatPositionEffect(
    variant: VariantResult,
    variants: readonly VariantResult[]
): string[] {
    const { name, positionEffect } = variant;
    if (positionEffect == null) {
        return [];
    }

    const { position, median, others } = positionEffect;
    const before = ranBefore(variant, variants, position);
    const named = before.map(other => (other === name ? 'itself' : other));
    const where = `${ordinal(position + 1)} in a round${named.length > 0 ? `, after ${named.join(' or ')}` : ''}`;

    return [
        `  ${name}: its rounds ran near ${formatTime(median)} when ${where}, and near ${formatTime(others)} otherwise: ${checkBefore(name, before)}`
    ];
}

/**
 * How to tell whether the variants that ran before a variant's position
 * cause its effect: a group without them. A variant that ran straight after
 * itself, at the end of the round before, as a rotation of 2 runs each,
 * can't be left out, and its own calls are the likely cause.
 */
function checkBefore(name: string, before: readonly string[]): string {
    const others = before.filter(other => other !== name);
    if (others.length > 0) {
        return `a group without ${others.join(' and ')} would show whether ${others.length === 1 ? 'it causes' : 'they cause'} it`;
    }

    return before.length > 0
        ? 'its own calls just before it may leave it work, as garbage to collect'
        : 'a group of its own would show whether another variant causes it';
}

/**
 * The variants that ran just before a variant in its rounds at a position:
 * the one before it in the round, or, at the first position, the last of the
 * round before, which it ran straight after. The rotation's orders give one
 * or two. It gives none where there are more, which no rotation makes.
 */
function ranBefore(
    { positions }: VariantResult,
    variants: readonly VariantResult[],
    position: number
): string[] {
    const names = new Set<string>();
    for (const [round, at] of positions.entries()) {
        const [previousRound, previousPosition] =
            position > 0
                ? [round, position - 1]
                : [round - 1, variants.length - 1];
        if (at === position && previousRound >= 0) {
            const previous = variants.find(
                other => other.positions[previousRound] === previousPosition
            );
            if (previous != null) {
                names.add(previous.name);
            }
        }
    }

    return names.size <= 2 ? Array.from(names) : [];
}

/** 1st, 2nd, 3rd, 4th, …, 11th, 12th, 13th, 21st, … */
function ordinal(count: number): string {
    const tens = Math.floor(count / 10) % 10;
    const suffix =
        tens === 1 ? 'th' : (['th', 'st', 'nd', 'rd'][count % 10] ?? 'th');

    return `${count}${suffix}`;
}

function formatModes({ name, summary }: VariantResult): string[] {
    const { modes } = summary;
    if (modes == null) {
        return [];
    }

    const { fast, slow } = modes;
    return [
        `  ${name}: two modes, ${fast.rounds} rounds near ${formatTime(fast.median)} and ${slow.rounds} near ${formatTime(slow.median)}`
    ];
}

/**
 * A note for a variant of a group that leads with the fastest round, whose
 * ratio lies outside its interval by more than `OUTSIDE_MARGIN`. The ratio
 * compares the fastest rounds, and the interval is of the median of the
 * per-round ratios, so the two then disagree: the variant's rounds differ
 * from its fastest by more than the reference's do, as when its calls
 * collect garbage or run in two modes, which the fastest round leaves out.
 * The median may then suit the group better as its lead.
 */
function formatOutside({ name, ratio, interval }: VariantResult): string[] {
    if (ratio == null || interval == null) {
        return [];
    }

    const [low, high] = interval;
    const reach = 1 + OUTSIDE_MARGIN;
    if (ratio >= low / reach && ratio <= high * reach) {
        return [];
    }

    return [
        `  ${name}: ${formatRatio(ratio)}× by the fastest rounds, but ${formatRatio(low)}–${formatRatio(high)}× round by round`
    ];
}

/** The width of the column of a process's ratios */
const PROCESS_WIDTH = 8;

/** The columns of a group's ratios after those of the processes */
const PROCESSES_COLUMNS: ReadonlyArray<
    readonly [title: string, width: number]
> = [
    ['median', 9],
    ['range', 15]
];

/**
 * The lines of a run's ratios in several processes: a paragraph that
 * describes them, and each group's table, of each variant's ratio in each
 * process, with their median and range, and its notes
 */
export function formatProcesses({ runs, groups }: Processes): string[] {
    const count = runs.length + 1;
    const description =
        count === 2
            ? "In 2 processes, the first of them the run above, and the other its repeat: each variant's ratio in each, by the statistic that its group leads with in the first, and their range. Two ratios have no median, and their range holds a process's median ratio with 50% confidence: 3 processes give 75%."
            : `In ${count} processes, the first of them the run above, and the others its repeats: each variant's ratio in each, by the statistic that its group leads with in the first, the median of the ${count} ratios, and their range.`;

    return ['', description, ...groups.flatMap(formatGroupAcrossProcesses)];
}

/**
 * A group's table of ratios in each process: its name and lead, a row for
 * each variant, a note for the processes that led with the other statistic,
 * and notes for a variant whose intervals of two processes are apart, whose
 * ratios lie on both sides of 1, or whose median is no further from 1 than
 * the A/A copy's median
 */
function formatGroupAcrossProcesses({
    name,
    lead,
    leads,
    variants
}: GroupAcrossProcesses): string[] {
    const [reference] = variants;
    const aa = variants.find(variant => variant.role === 'aa');
    const count = reference.ratios.length;
    const nameWidth = Math.max(
        NAME_WIDTH,
        ...variants.map(variant => variant.name.length)
    );
    const processes = Array.from({ length: count }, (_, i) =>
        String(i + 1).padStart(PROCESS_WIDTH)
    );
    const columns =
        count === 2 ? PROCESSES_COLUMNS.slice(1) : PROCESSES_COLUMNS;
    const summaries = columns.map(([title, width]) => title.padStart(width));

    return [
        '',
        `${name}: ${count} processes, by the ${lead} round`,
        `  ${''.padEnd(nameWidth)}${processes.join('')}${summaries.join('')}`,
        ...variants.map(variant => formatProcessesRow(variant, nameWidth)),
        ...formatOtherLeads(lead, leads),
        ...variants.flatMap(variant => formatApart(variant, lead)),
        ...variants.flatMap(variant =>
            formatBothSides(variant, reference.name)
        ),
        ...(aa == null
            ? []
            : variants.flatMap(variant => formatWithinAA(variant, aa)))
    ];
}

/**
 * A variant's row of ratios in each process, with their median, if they
 * have one, and their range
 */
function formatProcessesRow(
    { role, name, ratios, median, range }: VariantAcrossProcesses,
    nameWidth: number
): string {
    const [[, medianWidth], [, rangeWidth]] = PROCESSES_COLUMNS;
    const cells = [
        ...ratios.map(ratio => padCell(formatRatioCell(ratio), PROCESS_WIDTH)),
        ...(ratios.length === 2
            ? []
            : [padCell(formatRatioCell(median), medianWidth)]),
        padCell(
            role === 'reference'
                ? ''
                : range == null
                  ? '–'
                  : formatInterval(range),
            rangeWidth
        )
    ];

    // The reference's range is empty, and ends its row
    return `  ${name.padEnd(nameWidth)}${cells.join('')}`.trimEnd();
}

/**
 * A note for the processes whose group led with the other statistic than in
 * the first, in their own runs: their ratios in the table are by the
 * first's, from their rounds, and differ from those that their own tables
 * would have printed
 */
function formatOtherLeads(lead: Lead, leads: readonly Lead[]): string[] {
    const other = leads.flatMap((own, i) => (own === lead ? [] : [i + 1]));
    if (other.length === 0) {
        return [];
    }

    // Of the two statistics, the one that isn't the first's
    const own = leads[other[0] - 1];
    const [processes, their] =
        other.length === 1 ? ['process', 'its'] : ['processes', 'their'];
    return [
        `  ${processes} ${formatList(other)} led with the ${own} round: ${their} ratios here are by the ${lead} round, from ${their} rounds`
    ];
}

/**
 * Numbers, or phrases, as a sentence lists them: `2`, `2 and 4`, or
 * `2, 3 and 4`
 */
function formatList(items: ReadonlyArray<number | string>): string {
    const last = items[items.length - 1];

    return items.length === 1
        ? String(last)
        : `${items.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * A note for a variant whose 95% intervals of two processes don't overlap:
 * the two estimates of the median have disjoint confidence intervals.
 * It names the interval of the lowest end, and
 * the interval of the highest start, which are apart if any two are.
 *
 * An interval is of the median of the per-round ratios. In a group that
 * leads with the fastest round, whose ratios compare the fastest rounds,
 * the note says that it's round by round, so as not to quote an interval
 * as if it were of the ratios beside it.
 */
function formatApart(
    { name, intervals }: VariantAcrossProcesses,
    lead: Lead
): string[] {
    const present = intervals.flatMap((interval, i) =>
        interval == null ? [] : [{ process: i + 1, interval }]
    );
    if (present.length < 2) {
        return [];
    }

    let lowest = present[0];
    let highest = present[0];
    for (const entry of present) {
        lowest = entry.interval[1] < lowest.interval[1] ? entry : lowest;
        highest = entry.interval[0] > highest.interval[0] ? entry : highest;
    }
    if (highest.interval[0] <= lowest.interval[1]) {
        return [];
    }

    const [first, second] =
        lowest.process < highest.process
            ? [lowest, highest]
            : [highest, lowest];
    const byRound = lead === 'fastest' ? 'round by round, ' : '';
    return [
        `  ${name}: ${byRound}the intervals of processes ${first.process} and ${second.process} don't overlap, ${formatInterval(first.interval)} and ${formatInterval(second.interval)}`
    ];
}

/**
 * A note for a variant whose ratios lie on both sides of 1, as the table
 * prints them: it was faster than the reference in some processes, and
 * slower in others. A ratio that prints as 1.00 is neither. An A/A copy's
 * ratios lie on both sides of 1 as a rule, so it gets none.
 */
function formatBothSides(
    { name, role, ratios }: VariantAcrossProcesses,
    reference: string
): string[] {
    const printed = ratios.flatMap(ratio =>
        ratio == null ? [] : [printedRatio(ratio)]
    );
    const faster = printed.filter(ratio => ratio < 1).length;
    const slower = printed.filter(ratio => ratio > 1).length;
    if (role !== 'variant' || faster === 0 || slower === 0) {
        return [];
    }

    return [
        `  ${name}: faster than ${reference} in ${faster} ${faster === 1 ? 'process' : 'processes'}, and slower in ${slower}`
    ];
}

/**
 * A note for a variant whose median ratio is no further from 1, as a
 * factor either way, than the A/A copy's median: it differs from the
 * reference by no more than the reference's copy does in the median
 * process, which is what the measurement gives code that doesn't differ. It
 * compares the medians, like with like, rather than the variant's median
 * with the A/A copy's furthest ratio: one process whose A/A ratio lay far
 * from 1 would then dismiss a variant that differed alike in every process,
 * and more often the more processes there are. A median that prints as 1.00
 * shows no difference to explain, and gets none, and so do the ratios of 2
 * processes, which have no median.
 */
function formatWithinAA(
    { name, role, median }: VariantAcrossProcesses,
    aa: VariantAcrossProcesses
): string[] {
    if (
        role !== 'variant' ||
        median == null ||
        aa.median == null ||
        printedRatio(median) === 1 ||
        !(Math.abs(Math.log(median)) <= Math.abs(Math.log(aa.median)))
    ) {
        return [];
    }

    return [
        `  ${name}: median ${formatRatio(median)}×, no further from 1 than the A/A copy's median, ${formatRatio(aa.median)}×`
    ];
}

/**
 * A line that says which builds a run compares, by their modules as the
 * command line named them, how each group pairs them, and which of them the
 * process loaded first
 */
export function describeBuilds(
    { base, head }: Readonly<Record<BuildName, string>>,
    first: BuildName,
    aa: boolean
): string {
    const variants = aa ? "base, head, and base's A/A copy" : 'base and head';

    return `Comparing head, ${head}, with base, ${base}: each group is a variant of the two, as group / variant, of ${variants}. This process loaded ${first} first.`;
}

/** The columns of a comparison in one process */
const BUILD_COLUMNS: ReadonlyArray<readonly [title: string, width: number]> = [
    ['ratio', 9],
    ['95% interval', 15],
    ['A/A interval', 15]
];

/**
 * The lines of a comparison of two builds: a paragraph that describes it,
 * and a table of each group's variants, of head's ratio to base in each
 * process, with their median and range, or its interval and the A/A copy's
 * in a single process, and its notes
 */
export function formatBuilds({
    loadedFirst,
    variants
}: BuildComparison): string[] {
    const count = loadedFirst.length;
    const groups = Map.groupBy(variants, variant => variant.group);

    return [
        '',
        describeComparison(loadedFirst),
        ...Array.from(groups, ([name, members]) =>
            formatGroupOfBuilds(name, members, count)
        ).flat()
    ];
}

/** The paragraph above a comparison's tables */
function describeComparison(loadedFirst: readonly BuildName[]): string {
    const count = loadedFirst.length;
    if (count === 1) {
        return `Head against base in this process, which loaded ${loadedFirst[0]} first: each variant's ratio of head's time to base's, by the statistic that its pair leads with, its 95% interval, and the A/A copy's. With --processes 2 or more, the processes load each build first in turn.`;
    }

    const processes = (build: BuildName): string =>
        formatList(
            loadedFirst.flatMap((first, i) => (first === build ? [i + 1] : []))
        );
    const summary =
        count === 2
            ? 'and their range'
            : `the median of the ${count} ratios, and their range`;
    return `Head against base in ${count} processes: each variant's ratio of head's time to base's in each, by the statistic that its pair leads with in the first, ${summary}. Processes ${processes('base')} loaded base first, and ${processes('head')} head first.`;
}

/** A table of a group's variants across builds, and its notes */
function formatGroupOfBuilds(
    name: string,
    variants: readonly VariantAcrossBuilds[],
    count: number
): string[] {
    const [{ lead }] = variants;
    const nameWidth = Math.max(
        NAME_WIDTH,
        ...variants.map(variant => variant.variant.length)
    );
    const sameLead = variants.every(variant => variant.lead === lead);
    const by = sameLead
        ? `by the ${lead} round`
        : 'by the round that each pair leads with';
    const titles =
        count === 1
            ? BUILD_COLUMNS
            : [
                  ...Array.from(
                      { length: count },
                      (_, i) => [String(i + 1), PROCESS_WIDTH] as const
                  ),
                  ...(count === 2
                      ? PROCESSES_COLUMNS.slice(1)
                      : PROCESSES_COLUMNS)
              ];

    return [
        '',
        `${name}: ${count} ${count === 1 ? 'process' : 'processes'}, ${by}`,
        `  ${''.padEnd(nameWidth)}${titles.map(([title, width]) => title.padStart(width)).join('')}`,
        ...variants.map(variant => formatBuildsRow(variant, nameWidth)),
        ...(sameLead
            ? []
            : variants.map(
                  variant =>
                      `  ${variant.variant}: by the ${variant.lead} round`
              )),
        ...variants.map(formatDifferences),
        ...variants.flatMap(formatLoadOrder)
    ];
}

/**
 * A variant's row: its ratio, interval and the A/A copy's interval in a
 * single process, or else its ratio in each process, their median, if they
 * have one, and their range
 */
function formatBuildsRow(
    { variant, ratios, intervals, aa, median, range }: VariantAcrossBuilds,
    nameWidth: number
): string {
    const interval = (value: readonly [number, number] | null): string =>
        value == null ? '' : formatInterval(value);
    const [[, ratioWidth], [, intervalWidth], [, aaWidth]] = BUILD_COLUMNS;
    const [[, medianWidth], [, rangeWidth]] = PROCESSES_COLUMNS;
    const cells =
        ratios.length === 1
            ? [
                  padCell(formatRatioCell(ratios[0]), ratioWidth),
                  padCell(interval(intervals[0]), intervalWidth),
                  padCell(interval(aa?.intervals[0] ?? null), aaWidth)
              ]
            : [
                  ...ratios.map(ratio =>
                      padCell(formatRatioCell(ratio), PROCESS_WIDTH)
                  ),
                  ...(ratios.length === 2
                      ? []
                      : [padCell(formatRatioCell(median), medianWidth)]),
                  padCell(
                      range == null ? '–' : formatInterval(range),
                      rangeWidth
                  )
              ];

    return `  ${variant.padEnd(nameWidth)}${cells.join('')}`.trimEnd();
}

/**
 * A note of what each process's rounds showed of a variant's time in head
 * against base's: faster or slower beyond the A/A copy's noise, or within
 * it, or, without an A/A copy, beyond its interval, or within it
 */
function formatDifferences({
    variant,
    aa,
    differences
}: VariantAcrossBuilds): string {
    const noise = aa == null ? "its interval's noise" : "the A/A copy's noise";
    const count = differences.length;
    const counts = new Map<Difference | null, number>();
    for (const difference of differences) {
        counts.set(difference, (counts.get(difference) ?? 0) + 1);
    }

    const [only] = counts.keys();
    if (counts.size === 1 && only != null) {
        const where =
            count === 1
                ? ''
                : count === 2
                  ? ' in both processes'
                  : ` in all ${count} processes`;
        return only === 'within noise'
            ? `  ${variant}: within ${noise}${where}`
            : `  ${variant}: head ${only}${where}, beyond ${noise}`;
    }

    const parts = (
        [
            ['faster', `head faster in ${counts.get('faster')}`],
            ['slower', `head slower in ${counts.get('slower')}`],
            [
                'within noise',
                `within ${noise} in ${counts.get('within noise')}`
            ],
            [null, `without an interval in ${counts.get(null)}`]
        ] as const
    ).flatMap(([difference, text]) => (counts.has(difference) ? [text] : []));
    const processes = count === 1 ? 'process' : 'processes';
    return `  ${variant}: ${formatList(parts)} of ${count} ${processes}`;
}

/**
 * A note for a variant whose ratios in the processes that loaded base first
 * lie apart from those that loaded head first, as `LoadOrder` describes
 */
function formatLoadOrder({
    variant,
    loadOrder
}: VariantAcrossBuilds): string[] {
    const { base, head, apart } = loadOrder;
    if (!apart || base == null || head == null) {
        return [];
    }

    return [
        `  ${variant}: ${formatRatio(base)}× in the processes that loaded base first, and ${formatRatio(head)}× in those that loaded head first: which build a process loads first changes the ratio`
    ];
}

/** A ratio rounded as the table prints it, so that 1.004 is 1 */
function printedRatio(ratio: number): number {
    return Number(formatRatio(ratio));
}

/** An interval or a range of ratios, as `0.98–1.01` */
function formatInterval([low, high]: readonly [number, number]): string {
    return `${formatRatio(low)}–${formatRatio(high)}`;
}

/** A time in nanoseconds, to three significant digits, in a unit that fits */
export function formatTime(nanoseconds: number): string {
    const [value, unit] =
        nanoseconds < 1e3
            ? [nanoseconds, 'ns']
            : nanoseconds < 1e6
              ? [nanoseconds / 1e3, 'µs']
              : nanoseconds < 1e9
                ? [nanoseconds / 1e6, 'ms']
                : [nanoseconds / 1e9, 's'];

    return `${toSignificant(value)} ${unit}`;
}

/**
 * Bytes allocated per call, rounded to whole bytes, and from 0, as the
 * estimate of a call that allocates nothing can come out below it
 */
export function formatBytes(bytes: number): string {
    return `${Math.max(0, Math.round(bytes)).toLocaleString('en-US')} B`;
}

/** A ratio as a table cell, or a dash when the clock couldn't resolve it */
function formatRatioCell(ratio: number | null): string {
    return ratio == null ? '–' : `${formatRatio(ratio)}×`;
}

function formatRatio(ratio: number): string {
    return toSignificant(ratio);
}

/**
 * Three significant digits, or more for values of 1,000 or more, and two
 * decimals for values under 1. Values under 0.1 keep two significant digits,
 * so that the ratio of a variant much faster than the reference, such as
 * 0.0042, doesn't round to 0.00.
 */
function toSignificant(value: number): string {
    if (value > 0 && value < 0.1) {
        return value.toPrecision(2);
    }
    if (value < 10) {
        return value.toFixed(2);
    }

    return value < 100 ? value.toFixed(1) : value.toFixed(0);
}

/**
 * A run's results as JSON, indented, with each array of numbers on one line,
 * as samples would otherwise take a line each
 */
export function formatJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2).replaceAll(STRING_OR_NUMBER_ARRAY, joinNumbers)}\n`;
}

/**
 * A string, or an indented array of numbers, which `JSON.stringify` writes.
 * It matches each string whole, so that what looks like an array of numbers
 * inside one, as in a variant's name, is left as it is.
 */
const STRING_OR_NUMBER_ARRAY =
    /"(?:[^"\\]|\\.)*"|\[\s+([\d.e+-]+(?:,\s+[\d.e+-]+)*)\s+\]/g;

/** The numbers of an array on one line, or a string as it was */
function joinNumbers(match: string, numbers: string | undefined): string {
    return numbers ? `[${numbers.replaceAll(/,\s+/g, ', ')}]` : match;
}
