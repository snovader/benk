// V8's report as the results have it: what V8 did with each variant's code,
// tied to the variant by its `run`, and the report's functions, as plain
// data that `JSON.stringify` writes as they are.
//
// The traced run is another process, which runs the same script with the
// same arguments, and so measures the same groups, with the same variants,
// in the same order. It says where each variant's `run` starts, which ties
// the function at that position in V8's log to the variant. A timer loop,
// which `new Function` compiles without a name or a script, is tied to it
// when one of the loop's Turbofan compilations considered inlining that
// `run`, or when one of its deoptimizations was in it. The traces tie
// nothing else to a loop: Maglev's inlining isn't parsed.
import type {
    GroupResult,
    V8Counted,
    V8Deoptimization,
    V8Function,
    V8FunctionReport,
    V8Inlining,
    V8Position,
    V8VariantDeoptimization,
    VariantV8
} from '#source/core/types';
import type { SourceMaps } from './source-maps.ts';
import type { TracedBench, TracedVariant } from './traced-markers.ts';
import {
    collectFunctions,
    originalOf,
    type Counted,
    type DeoptimizationReport,
    type FunctionReport,
    type InliningDecision,
    type ReportedFunction,
    type Tier
} from './v8-report.ts';
import type {
    FunctionAddress,
    LoggedFunction,
    SourcePosition,
    V8Trace
} from './v8-trace.ts';

/** A function as the results have it */
export function plainFunction(fn: ReportedFunction): V8Function {
    return {
        name: fn.name,
        topLevel: fn.topLevel,
        position: fn.position == null ? null : plainPosition(fn.position),
        bytecodeSize: fn.bytecodeSize ?? null
    };
}

/** What V8 did with a function, as the results have it */
export function plainReport(report: FunctionReport): V8FunctionReport {
    return {
        ...plainFunction(report),
        tiers: report.tiers.map(plainCounted(plainTier)),
        deoptimizations: report.deoptimizations.map(
            plainCounted(plainDeoptimization)
        ),
        callees: report.callees.map(plainCounted(plainInlining)),
        callers: report.callers.map(plainCounted(plainInlining))
    };
}

/** Where a variant measured in a group of the results was in the traced run */
interface PairedVariant {
    /** The group's index in the results and in the traced run */
    readonly group: number;
    readonly groupName: string;
    readonly traced: TracedVariant;
}

/**
 * What V8 did with each variant's code, by each group and variant of the
 * results, of the `bench()` call of the traced run that measured them. A
 * group of the traced run pairs with the results' group of the same index,
 * if it has the same name, and a variant with its variant of the same name.
 * A variant without a pair has null.
 */
export function variantsV8(
    groups: readonly GroupResult[],
    bench: TracedBench,
    logged: ReadonlyMap<FunctionAddress, LoggedFunction>,
    sourceMaps: SourceMaps | undefined
): Array<Array<VariantV8 | null>> {
    const paired = pairVariants(groups, bench);
    const attribution = new Attribution(
        paired.flat().filter(variant => variant != null),
        bench,
        logged,
        sourceMaps
    );

    return paired.map(variants =>
        variants.map(variant =>
            variant == null ? null : attribution.variant(variant)
        )
    );
}

function pairVariants(
    groups: readonly GroupResult[],
    bench: TracedBench
): Array<Array<PairedVariant | null>> {
    return groups.map((group, i) => {
        const traced = bench.groups?.[i];

        return group.variants.map(({ name }) => {
            const variant = traced?.variants.find(v => v.name === name);
            return traced?.name === group.name && variant != null
                ? { group: i, groupName: group.name, traced: variant }
                : null;
        });
    });
}

/** What the traces tie to the variants of a `bench()` call */
class Attribution {
    readonly #variants: readonly PairedVariant[];
    readonly #bench: TracedBench;
    readonly #logged: ReadonlyMap<FunctionAddress, LoggedFunction>;
    readonly #original: (position: SourcePosition) => SourcePosition;
    /** What V8 did with each function in the `bench()` call */
    readonly #functions: ReadonlyMap<FunctionAddress, FunctionReport>;
    /** The functions at each `run`'s position, as the log has them */
    readonly #runs: ReadonlyMap<string, readonly FunctionAddress[]>;
    /** The timer loops tied to each `run`, by its position */
    readonly #loops: ReadonlyMap<string, ReadonlySet<FunctionAddress>>;

    constructor(
        variants: readonly PairedVariant[],
        bench: TracedBench,
        logged: ReadonlyMap<FunctionAddress, LoggedFunction>,
        sourceMaps: SourceMaps | undefined
    ) {
        this.#variants = variants;
        this.#bench = bench;
        this.#logged = logged;
        this.#original = originalOf(sourceMaps);
        this.#functions = new Map(
            collectFunctions(bench.trace, logged, sourceMaps).map(report => [
                report.function,
                report
            ])
        );

        const runs = runPositions(variants);
        this.#runs = functionsAt(runs, logged);
        this.#loops = new LoopTable(this.#runs, runs, logged).loops(
            bench.trace
        );
    }

    /** What V8 did with a variant's `run`, and with its loops */
    variant({ group, traced }: PairedVariant): VariantV8 {
        const key = traced.run == null ? undefined : positionKey(traced.run);
        const runs = key == null ? [] : (this.#runs.get(key) ?? []);
        const loops = Array.from(
            key == null ? [] : (this.#loops.get(key) ?? [])
        );
        const runReports = this.#reports(runs);
        const loopReports = this.#reports(loops);

        return {
            run: this.#runFunction(runs),
            runTiers: merged(
                runReports.flatMap(report => report.tiers),
                plainTier
            ),
            loops: loops.length,
            loopTiers: merged(
                loopReports.flatMap(report => report.tiers),
                plainTier
            ),
            inlining: merged(
                loopReports.flatMap(report => report.callees),
                plainInlining
            ),
            deoptimizations: this.#deoptimizations(
                new Set(runs),
                new Set(loops),
                group
            ),
            sharedWith: this.#sharing(key, traced)
        };
    }

    #reports(addresses: readonly FunctionAddress[]): FunctionReport[] {
        return addresses
            .map(address => this.#functions.get(address))
            .filter(report => report != null);
    }

    /**
     * The function of a `run`, as the traces name it, or as the log does,
     * if the traces don't, as for a `run` that V8 didn't optimize
     */
    #runFunction(runs: readonly FunctionAddress[]): V8Function | null {
        const [first] = runs;
        if (first == null) {
            return null;
        }

        const report = this.#functions.get(first);
        if (report != null) {
            return plainFunction(report);
        }

        // The log has each function at a `run`'s position
        const logged = this.#logged.get(first) as LoggedFunction;
        return plainFunction({
            ...logged,
            position: this.#original(logged.position)
        });
    }

    /**
     * The deoptimizations of a variant's `run` and loops, those alike
     * counted together, with how many were in its group's timed rounds
     */
    #deoptimizations(
        runs: ReadonlySet<FunctionAddress>,
        loops: ReadonlySet<FunctionAddress>,
        group: number
    ): V8VariantDeoptimization[] {
        // Parts of the call's traces, of the same deoptimizations
        const timed = new Set(this.#bench.timed[group]?.deoptimizations);
        const counts = new Map<string, V8VariantDeoptimization>();

        for (const deoptimization of this.#bench.trace.deoptimizations) {
            const code = codeOf(deoptimization.function, runs, loops);
            if (code == null) {
                continue;
            }

            const plain = {
                code,
                ...plainDeoptimization({
                    ...deoptimization,
                    positions: deoptimization.positions.map(this.#original)
                })
            };
            const key = JSON.stringify(plain);
            const known = counts.get(key);
            counts.set(key, {
                ...plain,
                count: (known?.count ?? 0) + 1,
                timed: (known?.timed ?? 0) + Number(timed.has(deoptimization))
            });
        }

        return Array.from(counts.values());
    }

    /** The other variants whose `run` is at the same position */
    #sharing(
        key: string | undefined,
        traced: TracedVariant
    ): Array<{ group: string; variant: string }> {
        if (key == null) {
            return [];
        }

        return this.#variants
            .filter(
                other =>
                    other.traced !== traced &&
                    other.traced.run != null &&
                    positionKey(other.traced.run) === key
            )
            .map(other => ({
                group: other.groupName,
                variant: other.traced.name
            }));
    }
}

/** Whose code a function's is: a variant's `run`'s, a loop's, or neither */
function codeOf(
    address: FunctionAddress,
    runs: ReadonlySet<FunctionAddress>,
    loops: ReadonlySet<FunctionAddress>
): 'run' | 'loop' | undefined {
    if (runs.has(address)) {
        return 'run';
    }

    return loops.has(address) ? 'loop' : undefined;
}

/**
 * The timer loops of a `bench()` call that its traces tie to each `run`:
 * functions compiled from a string, as `new Function` compiles them
 */
class LoopTable {
    readonly #positions: ReadonlyMap<string, readonly RunPosition[]>;
    readonly #logged: ReadonlyMap<FunctionAddress, LoggedFunction>;
    /** The position of each function at a `run`'s, by its address */
    readonly #runOf: ReadonlyMap<FunctionAddress, string>;

    constructor(
        runs: ReadonlyMap<string, readonly FunctionAddress[]>,
        positions: readonly RunPosition[],
        logged: ReadonlyMap<FunctionAddress, LoggedFunction>
    ) {
        this.#positions = Map.groupBy(
            positions,
            ({ position }) => position.url
        );
        this.#logged = logged;
        this.#runOf = new Map(
            Array.from(runs).flatMap(([key, addresses]) =>
                addresses.map(address => [address, key] as const)
            )
        );
    }

    loops(trace: V8Trace): Map<string, Set<FunctionAddress>> {
        const loops = new Map<string, Set<FunctionAddress>>();
        const tie = (key: string | undefined, loop: FunctionAddress): void => {
            if (key != null) {
                const tied = loops.get(key) ?? new Set();
                loops.set(key, tied.add(loop));
            }
        };

        for (const { function: loop, candidates } of trace.turbofan) {
            if (this.#isLoop(loop)) {
                for (const candidate of candidates) {
                    tie(this.#runOf.get(candidate.function), loop);
                }
            }
        }
        for (const { function: loop, positions } of trace.deoptimizations) {
            // The position before the loop's own is in the function that
            // the loop inlined at its call, which is a `run`
            if (this.#isLoop(loop) && positions.length >= 2) {
                tie(this.#enclosing(positions[positions.length - 2]), loop);
            }
        }

        return loops;
    }

    /** Whether a function was compiled from a string, as a timer loop is */
    #isLoop(address: FunctionAddress): boolean {
        return this.#logged.get(address)?.position.url === '';
    }

    /**
     * The `run` that a position is in: of those in its script, the one that
     * starts last before it. A `run` that another variant's `run` encloses
     * would take positions of the other.
     */
    #enclosing(at: SourcePosition): string | undefined {
        let enclosing: RunPosition | undefined;
        for (const run of this.#positions.get(at.url) ?? []) {
            const { line, column } = run.position;
            const before =
                line < at.line || (line === at.line && column <= at.column);
            if (before && (enclosing == null || isAfter(run, enclosing))) {
                enclosing = run;
            }
        }

        return enclosing?.key;
    }
}

/** A `run`'s position, and its key */
interface RunPosition {
    readonly key: string;
    readonly position: SourcePosition;
}

function runPositions(variants: readonly PairedVariant[]): RunPosition[] {
    const positions = new Map<string, RunPosition>();
    for (const { traced } of variants) {
        if (traced.run != null) {
            const key = positionKey(traced.run);
            positions.set(key, { key, position: traced.run });
        }
    }

    return Array.from(positions.values());
}

/** The functions that the log has at each `run`'s position, by its key */
function functionsAt(
    runs: readonly RunPosition[],
    logged: ReadonlyMap<FunctionAddress, LoggedFunction>
): Map<string, FunctionAddress[]> {
    const keys = new Set(runs.map(run => run.key));
    const functions = new Map<string, FunctionAddress[]>();

    for (const { function: address, position } of logged.values()) {
        const key = positionKey(position);
        if (keys.has(key)) {
            functions.set(key, [...(functions.get(key) ?? []), address]);
        }
    }

    return functions;
}

function isAfter(run: RunPosition, other: RunPosition): boolean {
    const { line, column } = run.position;

    return (
        line > other.position.line ||
        (line === other.position.line && column > other.position.column)
    );
}

function positionKey({ url, line, column }: SourcePosition): string {
    return `${url}\n${line}:${column}`;
}

/** Counted values as plain data, those that are alike counted together */
function merged<T, P>(
    counted: ReadonlyArray<Counted<T>>,
    plain: (value: T) => P
): Array<V8Counted<P>> {
    const counts = new Map<string, V8Counted<P>>();
    for (const { value, count } of counted) {
        const plainValue = plain(value);
        const key = JSON.stringify(plainValue);
        counts.set(key, {
            ...plainValue,
            count: (counts.get(key)?.count ?? 0) + count
        });
    }

    return Array.from(counts.values());
}

function plainCounted<T, P>(
    plain: (value: T) => P
): (counted: Counted<T>) => V8Counted<P> {
    return ({ value, count }) => ({ ...plain(value), count });
}

function plainTier({ tier, osr }: Tier): { tier: string; osr: boolean } {
    return { tier, osr };
}

function plainInlining({
    other,
    inlined,
    reason
}: InliningDecision): V8Inlining {
    return { function: plainFunction(other), inlined, reason: reason ?? null };
}

/** A deoptimization as the results have it */
export function plainDeoptimization({
    tier,
    kind,
    reason,
    positions
}: DeoptimizationReport): V8Deoptimization {
    return { tier, kind, reason, positions: positions.map(plainPosition) };
}

function plainPosition({ url, line, column }: SourcePosition): V8Position {
    return { url, line, column };
}
