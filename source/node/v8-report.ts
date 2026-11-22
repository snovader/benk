// The report of `--v8-report`: what V8 did with each hot function of a
// benchmark script, from the traces that `v8-trace.ts` parses. It names
// each function by the code log, which has its position and the size of its
// bytecode, and leaves out Node's functions and benk's, unless they
// deoptimized in the script's code. Its positions are in the sources that a
// script's source map names, as `source-maps.ts` reads them.
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBytes } from '#source/core/report';
import type { SourceMaps } from './source-maps.ts';
import type {
    Compilation,
    Deoptimization,
    FunctionAddress,
    LoggedFunction,
    SourcePosition,
    TurbofanCompilation,
    V8Trace
} from './v8-trace.ts';

/** A function, as the report names it */
export interface ReportedFunction {
    readonly function: FunctionAddress;
    /** Its name, or '' */
    readonly name: string;
    /** Whether it's a script's top level, rather than a function in it */
    readonly topLevel: boolean;
    /**
     * Where it starts, in the source that its script's source map names, or
     * undefined if the code log hasn't the function
     */
    readonly position: SourcePosition | undefined;
    /** The size of its bytecode, if the code log or the traces have it */
    readonly bytecodeSize: number | undefined;
}

/** Something that happened, and how many times */
export interface Counted<T> {
    readonly value: T;
    readonly count: number;
}

/** A tier that a function was compiled to */
export interface Tier {
    /** V8's name of the tier, such as `MAGLEV` or `TURBOFAN_JS` */
    readonly tier: string;
    /** Whether it compiled a running loop, for on-stack replacement */
    readonly osr: boolean;
}

/** Turbofan's decision whether to inline a function into another */
export interface InliningDecision {
    /** The other function: the one called, or the one compiled */
    readonly other: ReportedFunction;
    readonly inlined: boolean;
    /** Why it didn't, when V8 said */
    readonly reason: string | undefined;
}

/** A deoptimization of a function's optimized code */
export type DeoptimizationReport = Omit<Deoptimization, 'function' | 'name'>;

/** What V8 did with a function in the traced run */
export interface FunctionReport extends ReportedFunction {
    /** The compilations that completed, in the order of each tier's first */
    readonly tiers: ReadonlyArray<Counted<Tier>>;
    readonly deoptimizations: ReadonlyArray<Counted<DeoptimizationReport>>;
    /**
     * Its Turbofan compilations' decisions of the functions that it calls,
     * counted by compilation
     */
    readonly callees: ReadonlyArray<Counted<InliningDecision>>;
    /** Other functions' Turbofan compilations' decisions of this one */
    readonly callers: ReadonlyArray<Counted<InliningDecision>>;
}

/** Which functions the report lists, and where it places them */
export interface ReportOptions {
    /**
     * The URL of the directory of benk's own modules, which ends in `/`,
     * whose functions the report leaves out
     */
    readonly benkDirectory: string;
    /**
     * Selects the functions that the report lists by their names, as it
     * writes them, or none if it lists all of them
     */
    readonly filter?: RegExp;
    /**
     * The source maps of the scripts, whose sources the positions are put
     * in, or none if the positions are V8's
     */
    readonly sourceMaps?: SourceMaps;
}

/** How the report writes positions */
export interface FormatOptions {
    /** The path of the script that the report is of */
    readonly script: string;
    /** The directory that the report's paths are relative to */
    readonly directory: string;
    /** The filter that selected the functions, which the heading names */
    readonly filter?: RegExp;
    /**
     * The source maps that placed the positions. The heading names each
     * script of a position whose source map couldn't be read.
     */
    readonly sourceMaps?: SourceMaps;
    /**
     * The engine of the traced run, which the heading names, as `d8
     * 15.8.62.9`, or none for a run in the Node that reports it
     */
    readonly engine?: string;
}

const TIER_NAMES: Readonly<Record<string, string>> = {
    MAGLEV: 'Maglev',
    TURBOFAN_JS: 'Turbofan'
};

/**
 * The functions that the report lists, and what V8 did with each: those of
 * the script's own modules that V8 compiled, deoptimized or considered
 * inlining, and those of others, as benk's timer loops, that deoptimized
 * at a position in the script's code. The script's come first, each by
 * its position. A function that the code log doesn't have, whose script
 * can't be told, isn't listed, but named where it's inlined. With a filter,
 * it lists only those whose names match it.
 *
 * Its positions are in the sources that the scripts' source maps name,
 * where they name one, and tell the script's modules from others by them.
 */
export function reportFunctions(
    trace: V8Trace,
    logged: ReadonlyMap<FunctionAddress, LoggedFunction>,
    { benkDirectory, filter, sourceMaps }: ReportOptions
): FunctionReport[] {
    const original = (position: SourcePosition): SourcePosition =>
        sourceMaps?.original(position) ?? position;
    const functions = new FunctionTable(logged, tracedSizes(trace), original);
    const isScript = (url: string): boolean => isScriptUrl(url, benkDirectory);

    for (const compilation of trace.compilations) {
        functions.of(compilation).addTier(compilation);
    }
    for (const deoptimization of trace.deoptimizations) {
        functions.of(deoptimization).addDeoptimization({
            ...deoptimization,
            positions: deoptimization.positions.map(original)
        });
    }
    for (const compilation of trace.turbofan) {
        addDecisions(functions, compilation);
    }

    const reported = functions
        .reports()
        .filter(report => isReported(report, isScript, filter));
    return reported.sort((a, b) => comparePlaces(a, b, isScript));
}

/**
 * The scripts that the report can place a function or a deoptimization in,
 * by the URLs that V8 names them by: those of the functions that the traces
 * name, as the code log has them, and of the deoptimizations' positions.
 * Their source maps are those that the report needs.
 */
export function tracedScripts(
    trace: V8Trace,
    logged: ReadonlyMap<FunctionAddress, LoggedFunction>
): Set<string> {
    const scripts = new Set<string>();
    const add = (traced: Pick<Compilation, 'function'>): void => {
        const url = logged.get(traced.function)?.position.url;
        if (url != null) {
            scripts.add(url);
        }
    };

    trace.compilations.forEach(add);
    for (const deoptimization of trace.deoptimizations) {
        add(deoptimization);
        for (const { url } of deoptimization.positions) {
            scripts.add(url);
        }
    }
    for (const compilation of trace.turbofan) {
        add(compilation);
        compilation.candidates.forEach(add);
    }

    return scripts;
}

/**
 * The lines of the report: a heading, and then each function's name,
 * position and size of bytecode, with a line for each of its tiers'
 * compilations, its Turbofan inlining, and its deoptimizations. The
 * heading names the engine of a run in d8, the filter, and each script of
 * a position of the report whose source map couldn't be read, whose
 * positions are its own.
 */
export function formatV8Report(
    reports: readonly FunctionReport[],
    { script, directory, filter, sourceMaps, engine }: FormatOptions
): string[] {
    const where = engine == null ? '' : ` in ${engine}`;
    const heading = [
        '',
        `V8 report of ${relative(directory, script)}, from a run of it${where} with V8's traces, whose times aren't reported.`,
        "Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.",
        ...(filter == null
            ? []
            : [`Only the functions whose names match ${filter.source}.`]),
        ...unmappedNotes(reports, sourceMaps, directory)
    ];
    if (reports.length === 0) {
        const matching =
            filter == null ? '' : ` whose name matches ${filter.source}`;
        return [
            ...heading,
            `  No function of the script${matching} was optimized.`
        ];
    }

    return [
        ...heading,
        ...reports.flatMap(report => formatFunction(report, directory))
    ];
}

/**
 * A line for each script of a position of the report whose source map
 * couldn't be read, which says why, and that its positions are its own
 */
function unmappedNotes(
    reports: readonly FunctionReport[],
    sourceMaps: SourceMaps | undefined,
    directory: string
): string[] {
    if (sourceMaps == null || sourceMaps.unread().size === 0) {
        return [];
    }

    const placed = placedScripts(reports);
    return Array.from(sourceMaps.unread())
        .filter(([script]) => placed.has(script))
        .map(
            ([script, reason]) =>
                `Positions in ${formatPlace(script, directory)} are its own: ${reason}.`
        );
}

/** The scripts of the positions that the report writes */
function placedScripts(reports: readonly FunctionReport[]): Set<string> {
    const scripts = new Set<string>();
    const add = (position: SourcePosition | undefined): void => {
        if (position != null) {
            scripts.add(position.url);
        }
    };

    for (const report of reports) {
        add(report.position);
        for (const { value } of [...report.callees, ...report.callers]) {
            add(value.other.position);
        }
        for (const { value } of report.deoptimizations) {
            value.positions.forEach(add);
        }
    }

    return scripts;
}

/** The lines of a function of the report */
function formatFunction(report: FunctionReport, directory: string): string[] {
    const size =
        report.bytecodeSize == null
            ? ''
            : `, ${formatBytes(report.bytecodeSize)} of bytecode`;
    const tiers = report.tiers.map(
        ({ value, count }) => `${formatTier(value)}${formatCount(count)}`
    );
    const details = [
        ...report.callees.map(({ value, count }) => ({
            text: formatCallee(value, directory),
            count
        })),
        ...report.callers.map(({ value, count }) => ({
            text: formatCaller(value, directory),
            count
        })),
        ...report.deoptimizations.map(({ value, count }) => ({
            text: formatDeoptimization(value, directory),
            count
        }))
    ];

    return [
        `${formatName(report, directory)}${size}`,
        ...(tiers.length > 0 ? [`  compiled to ${tiers.join(', ')}`] : []),
        ...countedLines(details)
    ];
}

/**
 * A line for each text, once, with the sum of its counts: functions that the
 * report names alike, as benk's timer loops, are counted together
 */
function countedLines(
    details: ReadonlyArray<{ text: string; count: number }>
): string[] {
    const counts = new Map<string, number>();
    for (const { text, count } of details) {
        counts.set(text, (counts.get(text) ?? 0) + count);
    }

    return Array.from(
        counts,
        ([text, count]) => `  ${text}${formatCount(count)}`
    );
}

function formatCallee(
    { other, inlined, reason }: InliningDecision,
    directory: string
): string {
    const size =
        other.bytecodeSize == null
            ? ''
            : ` (${formatBytes(other.bytecodeSize)})`;
    const verb = inlined ? 'inlines' : "doesn't inline";

    return `${verb} ${formatName(other, directory)}${size}${formatReason(reason)}`;
}

function formatCaller(
    { other, inlined, reason }: InliningDecision,
    directory: string
): string {
    const verb = inlined ? 'inlined into' : 'not inlined into';

    return `${verb} ${formatName(other, directory)}${formatReason(reason)}`;
}

function formatDeoptimization(
    { tier, kind, reason, positions }: DeoptimizationReport,
    directory: string
): string {
    const code = `${formatTier({ tier, osr: false })}'s code`;
    const cause = `${reason} (${kind.replace(/^deopt-/, '')})`;
    const at = positions
        .map(position => formatPosition(position, directory))
        .join(', inlined at ');

    return `deoptimized in ${code}: ${cause}${at === '' ? '' : `, at ${at}`}`;
}

/** A function's name, and its position if the code log has it */
function formatName(fn: ReportedFunction, directory: string): string {
    const name = displayName(fn);

    return fn.position == null
        ? name
        : `${name} ${formatPosition(fn.position, directory)}`;
}

/** A function's name as the report writes it, which its filter matches */
function displayName({ name, topLevel }: ReportedFunction): string {
    return topLevel ? '(top level)' : name || '(anonymous)';
}

/** A position, with its script as `formatPlace()` writes it */
function formatPosition(
    { url, line, column }: SourcePosition,
    directory: string
): string {
    return `${formatPlace(url, directory)}:${line}:${column}`;
}

/**
 * A script, by a file's path relative to the directory, and `<anonymous>`
 * for a script compiled from a string, as V8's stack traces write it
 */
function formatPlace(url: string, directory: string): string {
    return url.startsWith('file:')
        ? relative(directory, fileURLToPath(url))
        : url || '<anonymous>';
}

function formatTier({ tier, osr }: Tier): string {
    return `${TIER_NAMES[tier] ?? tier}${osr ? ' (OSR)' : ''}`;
}

function formatReason(reason: string | undefined): string {
    return reason == null ? '' : `: ${reason}`;
}

function formatCount(count: number): string {
    return count > 1 ? ` ×${count}` : '';
}

/**
 * Whether a script is the benchmark's, or a module that it imports, rather
 * than Node's own, benk's, or code compiled from a string
 */
function isScriptUrl(url: string, benkDirectory: string): boolean {
    return (
        url !== '' && !url.startsWith('node:') && !url.startsWith(benkDirectory)
    );
}

/**
 * The sizes of bytecode that Turbofan's candidates have in the traces, for
 * functions that the code log has no size of, as Node's from its snapshot
 */
function tracedSizes(trace: V8Trace): Map<FunctionAddress, number> {
    const sizes = new Map<FunctionAddress, number>();
    for (const { candidates } of trace.turbofan) {
        for (const { function: address, bytecodeSize } of candidates) {
            if (bytecodeSize != null) {
                sizes.set(address, bytecodeSize);
            }
        }
    }

    return sizes;
}

/** Adds a Turbofan compilation's decisions to the functions on both sides */
function addDecisions(
    functions: FunctionTable,
    compilation: TurbofanCompilation
): void {
    const compiled = functions.of(compilation);

    for (const candidate of compilation.candidates) {
        const callee = functions.of(candidate);
        const { inlined, reason } = candidate;

        compiled.addCallee({ other: callee.described(), inlined, reason });
        callee.addCaller({ other: compiled.described(), inlined, reason });
    }
}

/**
 * Whether the report lists a function: one of the script's, or one that
 * deoptimized at a position in the script's code, whose name matches the
 * filter, if there's one
 */
function isReported(
    report: FunctionReport,
    isScript: (url: string) => boolean,
    filter: RegExp | undefined
): report is PlacedReport {
    if (
        report.position == null ||
        (filter != null && !filter.test(displayName(report)))
    ) {
        return false;
    }

    return (
        isScript(report.position.url) ||
        report.deoptimizations.some(({ value }) =>
            value.positions.some(at => isScript(at.url))
        )
    );
}

/** The report of a function whose position the code log has */
type PlacedReport = FunctionReport & { readonly position: SourcePosition };

/** Orders the script's functions first, then others, each by position */
function comparePlaces(
    { position: first }: PlacedReport,
    { position: second }: PlacedReport,
    isScript: (url: string) => boolean
): number {
    return (
        Number(!isScript(first.url)) - Number(!isScript(second.url)) ||
        first.url.localeCompare(second.url) ||
        first.line - second.line ||
        first.column - second.column
    );
}

/** The functions that the traces name, by address, as the report collects them */
class FunctionTable {
    readonly #logged: ReadonlyMap<FunctionAddress, LoggedFunction>;
    readonly #tracedSizes: ReadonlyMap<FunctionAddress, number>;
    readonly #original: (position: SourcePosition) => SourcePosition;
    readonly #functions = new Map<FunctionAddress, FunctionBuilder>();

    constructor(
        logged: ReadonlyMap<FunctionAddress, LoggedFunction>,
        tracedSizes: ReadonlyMap<FunctionAddress, number>,
        original: (position: SourcePosition) => SourcePosition
    ) {
        this.#logged = logged;
        this.#tracedSizes = tracedSizes;
        this.#original = original;
    }

    /**
     * The function at an address, with the name that the traces give it, and
     * the size of bytecode that they print, where the log has neither, and
     * its position in its source
     */
    of(traced: Pick<Compilation, 'function' | 'name'>): FunctionBuilder {
        let fn = this.#functions.get(traced.function);
        if (fn == null) {
            const logged = this.#logged.get(traced.function);
            fn = new FunctionBuilder({
                function: traced.function,
                name: logged?.name ?? traced.name,
                topLevel: logged?.topLevel ?? false,
                position:
                    logged == null
                        ? undefined
                        : this.#original(logged.position),
                bytecodeSize:
                    logged?.bytecodeSize ??
                    this.#tracedSizes.get(traced.function)
            });
            this.#functions.set(traced.function, fn);
        }

        return fn;
    }

    reports(): FunctionReport[] {
        return Array.from(this.#functions.values(), fn => fn.build());
    }
}

/** What V8 did with a function, as the traces tell it */
class FunctionBuilder {
    readonly #described: ReportedFunction;
    readonly #tiers = new Counter<Tier>();
    readonly #deoptimizations = new Counter<DeoptimizationReport>();
    readonly #callees = new Counter<InliningDecision>();
    readonly #callers = new Counter<InliningDecision>();

    constructor(described: ReportedFunction) {
        this.#described = described;
    }

    described(): ReportedFunction {
        return this.#described;
    }

    addTier({ tier, osr }: Compilation): void {
        this.#tiers.add(`${tier} ${osr}`, { tier, osr });
    }

    addDeoptimization({ tier, kind, reason, positions }: Deoptimization): void {
        const key = JSON.stringify([tier, kind, reason, positions]);
        this.#deoptimizations.add(key, { tier, kind, reason, positions });
    }

    addCallee(decision: InliningDecision): void {
        this.#callees.add(decisionKey(decision), decision);
    }

    addCaller(decision: InliningDecision): void {
        this.#callers.add(decisionKey(decision), decision);
    }

    build(): FunctionReport {
        return {
            ...this.#described,
            tiers: this.#tiers.counts(),
            deoptimizations: this.#deoptimizations.counts(),
            callees: this.#callees.counts(),
            callers: this.#callers.counts()
        };
    }
}

function decisionKey({ other, inlined, reason }: InliningDecision): string {
    return JSON.stringify([other.function, inlined, reason ?? null]);
}

/** Counts values by a key, in the order of each key's first */
class Counter<T> {
    readonly #counts = new Map<string, { value: T; count: number }>();

    add(key: string, value: T): void {
        const counted = this.#counts.get(key);
        if (counted == null) {
            this.#counts.set(key, { value, count: 1 });
        } else {
            counted.count++;
        }
    }

    counts(): Array<Counted<T>> {
        return Array.from(this.#counts.values(), ({ value, count }) => ({
            value,
            count
        }));
    }
}
