import { ALLOCATING_CALL, LONG_CALL } from './lead.ts';
import type {
    GroupAcrossProcesses,
    GroupResult,
    Lead,
    LeadReason,
    Processes,
    RecordedOptions,
    RuntimeDescription,
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
 * rounds are few times the timer's resolution, a note for each variant whose rounds
 * form two modes, and one for each whose ratio by the fastest round lies
 * outside its interval
 */
export function formatGroup({
    name,
    lead,
    leadReason,
    rounds,
    timerResolution,
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
        ...variants.flatMap(formatModes),
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
        `${formatRatio(ratio)}×`,
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
    if (interval == null) {
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
    const summaries = summaryColumns(reference).map(([title, width]) =>
        title.padStart(width)
    );

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
 * The columns of a group's ratios after those of the processes: the median
 * and the range, or the range alone, where the ratios have no median
 */
function summaryColumns({
    median
}: VariantAcrossProcesses): typeof PROCESSES_COLUMNS {
    return median == null ? PROCESSES_COLUMNS.slice(1) : PROCESSES_COLUMNS;
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
        ...ratios.map(ratio =>
            padCell(`${formatRatio(ratio)}×`, PROCESS_WIDTH)
        ),
        ...(median == null
            ? []
            : [padCell(`${formatRatio(median)}×`, medianWidth)]),
        padCell(role === 'reference' ? '' : formatInterval(range), rangeWidth)
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

/** Numbers as a sentence lists them: `2`, `2 and 4`, or `2, 3 and 4` */
function formatList(numbers: readonly number[]): string {
    const last = numbers[numbers.length - 1];

    return numbers.length === 1
        ? String(last)
        : `${numbers.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * A note for a variant whose 95% intervals of two processes don't overlap:
 * its ratio differed between them by more than its rounds varied within
 * either, so that the interval of one process understates how much the
 * ratio varies between runs. It names the interval of the lowest end, and
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
    const printed = ratios.map(printedRatio);
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
