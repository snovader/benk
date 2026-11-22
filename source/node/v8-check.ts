// The check of `--v8-check`, of the functions that V8's report lists, which
// fails the run in CI: a function of the script too large for Turbofan to
// inline, where it tried, one over the user's own limit, and code that
// deoptimized while a group's rounds were timed.
import type {
    InliningLimits,
    V8Check,
    V8DeoptimizationFailure,
    V8SizeFailure
} from '#source/core/types';
import type { SourceMaps } from './source-maps.ts';
import { originalOf, type FunctionReport } from './v8-report.ts';
import { plainDeoptimization, plainFunction } from './v8-results.ts';
import type { V8Trace } from './v8-trace.ts';

/** The traces of a group's timed rounds */
export interface TimedGroup {
    readonly name: string;
    readonly trace: V8Trace;
}

/** What the check compares the functions with */
export interface CheckOptions {
    readonly limits: InliningLimits;
    /** The user's limit of `--v8-max-bytecode`, or none */
    readonly maxBytecodeSize: number | undefined;
    /** Whether a script is the benchmark's, as the report tells them */
    readonly isScript: (url: string) => boolean;
    readonly sourceMaps?: SourceMaps;
}

/**
 * Checks the functions that the report lists, and fails:
 *
 * - **over budget**: a function of the script whose bytecode is over
 *   `--max-inlined-bytecode-size`, which a Turbofan compilation considered
 *   inlining, as it does a function that optimized code calls, and so
 *   couldn't;
 * - **over limit**: a function of the script whose bytecode is over the
 *   user's limit, which Turbofan compiled, or considered inlining;
 * - **deoptimized**: a deoptimization of a listed function's code in a
 *   group's timed rounds, after its warm-up, when its rounds' times were
 *   taken.
 *
 * A script's top level, which isn't inlined, isn't checked for its size.
 */
export function checkFunctions(
    listed: readonly FunctionReport[],
    timed: readonly TimedGroup[],
    options: CheckOptions
): V8Check {
    const failures = [
        ...listed.flatMap(report => sizeFailures(report, options)),
        ...deoptimizationFailures(listed, timed, options.sourceMaps)
    ];

    return {
        passed: failures.length === 0,
        maxBytecodeSize: options.maxBytecodeSize ?? null,
        failures
    };
}

function sizeFailures(
    report: FunctionReport,
    { limits, maxBytecodeSize, isScript }: CheckOptions
): V8SizeFailure[] {
    const { position, bytecodeSize, topLevel, callers, tiers } = report;
    if (
        position == null ||
        bytecodeSize == null ||
        topLevel ||
        !isScript(position.url)
    ) {
        return [];
    }

    const considered = callers.length > 0;
    const compiled = tiers.some(({ value }) => value.tier === 'TURBOFAN_JS');
    const failure = (
        kind: V8SizeFailure['kind'],
        limit: number
    ): V8SizeFailure => ({
        kind,
        function: plainFunction(report),
        limit,
        consideredFor: Array.from(
            new Map(
                callers.map(({ value }) => [value.other.function, value.other])
            ).values(),
            plainFunction
        )
    });

    const failures: V8SizeFailure[] = [];
    if (considered && bytecodeSize > limits.maxInlinedBytecodeSize) {
        failures.push(failure('over budget', limits.maxInlinedBytecodeSize));
    }
    if (
        maxBytecodeSize != null &&
        bytecodeSize > maxBytecodeSize &&
        (considered || compiled)
    ) {
        failures.push(failure('over limit', maxBytecodeSize));
    }

    return failures;
}

/**
 * The deoptimizations in each group's timed rounds of the listed functions,
 * those alike counted together
 */
function deoptimizationFailures(
    listed: readonly FunctionReport[],
    timed: readonly TimedGroup[],
    sourceMaps: SourceMaps | undefined
): V8DeoptimizationFailure[] {
    const reports = new Map(listed.map(report => [report.function, report]));
    const original = originalOf(sourceMaps);
    const failures = new Map<string, V8DeoptimizationFailure>();

    for (const { name, trace } of timed) {
        for (const deoptimization of trace.deoptimizations) {
            const report = reports.get(deoptimization.function);
            if (report == null) {
                continue;
            }

            const failure: V8DeoptimizationFailure = {
                kind: 'deoptimized',
                group: name,
                function: plainFunction(report),
                deoptimization: plainDeoptimization({
                    ...deoptimization,
                    positions: deoptimization.positions.map(original)
                }),
                count: 1
            };
            const key = JSON.stringify([
                name,
                report.function,
                failure.deoptimization
            ]);
            const known = failures.get(key);
            failures.set(
                key,
                known == null ? failure : { ...known, count: known.count + 1 }
            );
        }
    }

    return Array.from(failures.values());
}
