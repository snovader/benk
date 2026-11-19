import { ALLOCATING_CALL, LONG_CALL } from './lead.ts';
import type {
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
    ['heap', 12]
];

/** The narrowest column of names */
const NAME_WIDTH = 16;

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

    return [
        `${runtime.name} ${runtime.version}, ${runtime.engine}, ${runtime.platform} ${runtime.arch}, ${runtime.cpu}${flags}.`,
        `Per call, of at least ${rounds} interleaved rounds of ${sampleTime} ms per variant after ${warmupRounds} warm-up rounds, in an order that rotates each variant through each position:`,
        "the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios" +
            (heap ? ', and the bytes allocated on the heap.' : '.')
    ].join('\n');
}

/**
 * A group's table: its name and lead, a row for each variant, and a note for
 * each variant whose rounds form two modes
 */
export function formatGroup({
    name,
    lead,
    leadReason,
    rounds,
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
        ...variants.flatMap(formatModes)
    ];
}

function formatRow(variant: VariantResult, nameWidth: number): string {
    const { summary, ratio, interval, heapBytes } = variant;
    const cells = [
        formatTime(summary.fastest),
        formatTime(summary.median),
        `${(summary.spread * 100).toFixed(1)}%`,
        `${formatRatio(ratio)}×`,
        interval === null
            ? ''
            : `${formatRatio(interval[0])}–${formatRatio(interval[1])}`,
        heapBytes === null ? '–' : formatBytes(heapBytes)
    ];

    return `  ${variant.name.padEnd(nameWidth)}${cells.map((cell, i) => cell.padStart(COLUMNS[i][1])).join('')}`;
}

function formatModes({ name, summary }: VariantResult): string[] {
    const { modes } = summary;
    if (modes === null) {
        return [];
    }

    const { fast, slow } = modes;
    return [
        `  ${name}: two modes, ${fast.rounds} rounds near ${formatTime(fast.median)} and ${slow.rounds} near ${formatTime(slow.median)}`
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

/** Three significant digits, or more for values of 1,000 or more */
function toSignificant(value: number): string {
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
    return `${JSON.stringify(value, null, 2).replaceAll(NUMBER_ARRAY, joinNumbers)}\n`;
}

/** An indented array of numbers, which `JSON.stringify` writes */
const NUMBER_ARRAY = /\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/gu;

function joinNumbers(_: string, numbers: string): string {
    return `[${numbers.replaceAll(/,\s+/gu, ', ')}]`;
}
