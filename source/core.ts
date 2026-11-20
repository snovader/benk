// The entry point of benk's core, `benk/core`, which loads none of Node's
// modules, so that a script can import it where they're missing, as in a
// Worker or a browser. It has no runtime of its own: a caller passes the
// `Runtime` that times the variants.
import * as measure from './core/measure.ts';
import type { MeasureOptions, RunOptions } from './core/measure.ts';
import type { Group, GroupResult, RunResult, Runtime } from './core/types.ts';

export { DEFAULT_OPTIONS } from './core/measure.ts';
export { chooseLead } from './core/lead.ts';
export {
    describeRun,
    formatBytes,
    formatGroup,
    formatJson,
    formatTime
} from './core/report.ts';
export { rotation } from './core/rotation.ts';
export { medianInterval, summarize } from './core/statistics.ts';
export { asyncTimerSource, timerSource } from './core/timer-source.ts';
export type { MeasureOptions, RunOptions } from './core/measure.ts';
export type { LeadChoice, LeadInput } from './core/lead.ts';
export type * from './core/types.ts';

/** Where a run's variants are timed, which the core has no default for */
export interface RuntimeOption {
    readonly runtime: Runtime;
}

/**
 * Measures a group's variants interleaved, as `benk`'s `measureGroup()`
 * does, with the runtime that the options name
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If the group has no variants, or two of the same name.
 * @throws {Error} If the runtime's clock reads no time, or if a variant
 * throws, with its error as the cause.
 */
export function measureGroup(
    group: Group,
    options: MeasureOptions & RuntimeOption
): Promise<GroupResult> {
    return measure.measureGroup(group, options, options.runtime);
}

/**
 * Measures each group whose name matches the filter, as `benk`'s
 * `measureGroups()` does, with the runtime that the options name
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If a group has no variants, or two of the same name.
 * @throws {Error} If the runtime's clock reads no time, or if a variant
 * throws, with its error as the cause.
 */
export function measureGroups(
    groups: Iterable<Group>,
    options: RunOptions & RuntimeOption
): Promise<RunResult> {
    return measure.measureGroups(groups, options, options.runtime);
}
