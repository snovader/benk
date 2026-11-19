// benk's entry point, which times variants in Node. The core, in `core/`,
// takes the runtime that it times them with: this module passes Node's.
import * as core from './core/measure.ts';
import type { MeasureOptions, RunOptions } from './core/measure.ts';
import type { Group, GroupResult, Runtime, RunResult } from './core/types.ts';
import { defaultRuntime } from './node/cli.ts';

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
export { main, parseOptions } from './node/cli.ts';
export { detachArrayBuffer, NodeRuntime } from './node/runtime.ts';
export type { MeasureOptions, RunOptions } from './core/measure.ts';
export type { LeadChoice, LeadInput } from './core/lead.ts';
export type { CommandOptions, MainOptions } from './node/cli.ts';
export type * from './core/types.ts';

/** Where a run's variants are timed: in Node's runtime by default */
export interface RuntimeOption {
    readonly runtime?: Runtime;
}

/**
 * Measures a group's variants interleaved, as the README describes: in
 * rotating order, after calibration and warm-up rounds, and with an A/A copy
 * of the first variant unless `aa` is false
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If the group has no variants, or two of the same name.
 * @throws {Error} If a variant throws, with its error as the cause.
 */
export function measureGroup(
    group: Group,
    options: MeasureOptions & RuntimeOption = {}
): Promise<GroupResult> {
    return core.measureGroup(
        group,
        options,
        options.runtime ?? defaultRuntime()
    );
}

/**
 * Measures each group whose name matches the filter, one after another, and
 * calls `onGroup` with each group's results as soon as it's measured
 *
 * @throws {RangeError} If an option is out of its range.
 * @throws {TypeError} If a group has no variants, or two of the same name.
 * @throws {Error} If a variant throws, with its error as the cause.
 */
export function measureGroups(
    groups: Iterable<Group>,
    options: RunOptions & RuntimeOption = {}
): Promise<RunResult> {
    return core.measureGroups(
        groups,
        options,
        options.runtime ?? defaultRuntime()
    );
}
