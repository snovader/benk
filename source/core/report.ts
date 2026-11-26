import { ALLOCATING_CALL, LONG_CALL } from './lead.ts';
import type {
    Change,
    GroupResult,
    LeadReason,
    RecordedOptions,
    RuntimeDescription,
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
 * rounds changed partway or else form two modes, and one for each whose ratio
 * by the fastest round lies outside its interval
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
        ...variants.flatMap(formatRounds),
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

/**
 * A note of how a variant's rounds differ: a change partway, or else two
 * modes. A change takes the modes' place, as its rounds before and after it
 * are apart by more than their spread too, and it says when each ran.
 * Results that a version before `schema` 5 wrote have no change, and get the
 * modes' note.
 */
function formatRounds(variant: VariantResult): string[] {
    return variant.change == null
        ? formatModes(variant)
        : formatChange(variant.name, variant.change);
}

/**
 * A note for a variant whose rounds changed partway, which names the shorter
 * part first. Rounds that got faster are more often those before V8's
 * optimized code took over, which more warm-up rounds would leave out.
 * Rounds that got slower are more often a deoptimization, or load from other
 * processes, which another run shows.
 */
function formatChange(name: string, { before, after }: Change): string[] {
    const parts =
        before.rounds <= after.rounds
            ? `the first ${before.rounds} rounds ran near ${formatTime(before.median)}, and the other ${after.rounds} near ${formatTime(after.median)}`
            : `the last ${after.rounds} rounds ran near ${formatTime(after.median)}, and the other ${before.rounds} near ${formatTime(before.median)}`;
    const advice =
        after.median < before.median
            ? 'more warm-up rounds, or a longer sample time, would time only the faster rounds'
            : "another run shows whether that repeats, and V8's report whether its code deoptimized";

    return [`  ${name}: ${parts}: ${advice}`];
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
