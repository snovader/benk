// The types that the core shares with a runtime and with callers: what a
// group of variants is, what a runtime provides to time them, and the results,
// which are plain data that `JSON.stringify` writes as they are.

/** A way of doing the work that a group times, whose calls a round repeats */
export interface SyncVariant {
    readonly name: string;
    /**
     * The call that's timed. The last result of each round is kept alive, so
     * that the work can't be eliminated. It mustn't return a promise: an
     * `AsyncVariant` awaits its calls.
     */
    readonly run: () => unknown;
    readonly async?: false;
    /**
     * Prepares one loop of calls before it starts, untimed: each round's,
     * calibration's and heap sample's. It's given the loop's count of calls,
     * so that a variant whose calls each need fresh input, such as an array
     * that a call sorts in place, can prepare that many.
     */
    readonly setup?: (repetitions: number) => void;
    /** Cleans up after one loop of calls, untimed */
    readonly teardown?: () => void;
}

/**
 * A variant whose calls return promises, which a loop of its own awaits one
 * at a time. The await costs more than a sync call: see the README's
 * measurement of the two loops.
 */
export interface AsyncVariant {
    readonly name: string;
    readonly run: () => PromiseLike<unknown>;
    readonly async: true;
    readonly setup?: (repetitions: number) => void | PromiseLike<void>;
    readonly teardown?: () => void | PromiseLike<void>;
}

export type Variant = SyncVariant | AsyncVariant;

/**
 * The statistic that a group's ratios compare: each variant's fastest round,
 * or its median round
 */
export type Lead = 'fastest' | 'median';

/** Variants that are timed together, interleaved, and reported as one table */
export interface Group {
    readonly name: string;
    /** The first is the reference, which every ratio compares with */
    readonly variants: readonly Variant[];
    /**
     * The statistic that the ratios compare, or `'auto'` to choose it from
     * the calls' time and allocation, as `chooseLead()` describes. `'auto'`
     * by default.
     */
    readonly lead?: Lead | 'auto';
    /** Whether to add an A/A pair to this group, in place of the run's option */
    readonly aa?: boolean;
}

/**
 * A loop that calls `run` `repetitions` times, keeps the last result alive,
 * and returns the time that the calls took, in milliseconds. Each variant has
 * a loop of its own, so that its call site and type feedback aren't shared.
 */
export type Timer = (run: () => unknown, repetitions: number) => number;

/** A loop like `Timer`'s, which awaits each call before the next */
export type AsyncTimer = (
    run: () => PromiseLike<unknown>,
    repetitions: number
) => Promise<number>;

/** Counts the bytes allocated on a runtime's garbage-collected heap */
export interface HeapMeter {
    /**
     * Starts counting, and returns the function that stops and returns the
     * bytes allocated since, whether or not they were collected meanwhile
     */
    start(): () => number;
}

/** What a run's results record about the runtime that timed it */
export interface RuntimeDescription {
    /** Such as `'Node'` */
    readonly name: string;
    readonly version: string;
    /** Such as `'V8 14.6.202.33'` */
    readonly engine: string;
    readonly platform: string;
    readonly arch: string;
    /** The processor's model, as the runtime reports it */
    readonly cpu: string;
    /** The flags that the runtime started with, such as V8's */
    readonly flags: readonly string[];
    /**
     * What the runtime knows of the process that changes what's timed, such
     * as Node's `'detached ArrayBuffer'`
     */
    readonly processState: readonly string[];
}

/**
 * What the core needs from a JavaScript runtime to time variants. The core
 * uses nothing else that's particular to one, such as Node's modules.
 */
export interface Runtime {
    readonly description: RuntimeDescription;
    /** Creates a timer loop that no other variant's loop shares */
    createTimer(): Timer;
    /** Creates an awaiting timer loop that no other variant's loop shares */
    createAsyncTimer(): AsyncTimer;
    /** Counts heap allocations, where the runtime can */
    readonly heap: HeapMeter | undefined;
}

/** Whether a variant is its group's reference, the A/A copy of it, or another */
export type Role = 'reference' | 'aa' | 'variant';

/** One of two clusters that a variant's rounds fall into */
export interface Mode {
    /** The median round of the cluster, in nanoseconds per call */
    readonly median: number;
    readonly rounds: number;
}

/**
 * A variant's rounds in two clusters, apart from each other by much more than
 * their own spread, as V8's tiering can make them: in some processes or
 * rounds a call gets faster code than in others. The median and the fastest
 * then describe one of the clusters, and a ratio compares a cluster with
 * another variant's.
 */
export interface Modes {
    readonly fast: Mode;
    readonly slow: Mode;
}

/** A summary of a variant's rounds, in nanoseconds per call */
export interface Summary {
    readonly fastest: number;
    /** The first quartile */
    readonly q1: number;
    /**
     * Of an even count of rounds, the slower of the middle two, as in Go's
     * and C++'s harnesses, so that it's a round's time rather than an
     * average of two
     */
    readonly median: number;
    /** The third quartile */
    readonly q3: number;
    readonly slowest: number;
    /** The interquartile range as a share of the median: 0.02 for 2% */
    readonly spread: number;
    /** The two clusters of the rounds, or null when they don't form two */
    readonly modes: Modes | null;
}

export interface VariantResult {
    readonly name: string;
    readonly role: Role;
    readonly async: boolean;
    /** The calls in each round */
    readonly repetitions: number;
    /** The time per call of each round, in nanoseconds, in the rounds' order */
    readonly samples: readonly number[];
    /** The variant's position in each round, from 0 */
    readonly positions: readonly number[];
    readonly summary: Summary;
    /**
     * The ratio to the reference's time by the group's lead: the fastest
     * round's to the reference's fastest, or the median of the ratios of
     * each round's time to the reference's in the same round
     */
    readonly ratio: number;
    /**
     * A 95% confidence interval of the median of the per-round ratios, or
     * null for the reference itself, and with fewer than 6 rounds
     */
    readonly interval: readonly [low: number, high: number] | null;
    /**
     * The bytes that a call allocated on the heap, or null where the runtime
     * can't count them or the run didn't. It's an estimate, which noise can
     * take below 0 for a call that allocates nothing.
     */
    readonly heapBytes: number | null;
}

/** Why a group's ratios compare the statistic that they do */
export type LeadReason =
    /** The group set it */
    | 'set'
    /** Every call took under 1 µs and allocated under 1 KiB */
    | 'short calls'
    /** A call took 1 µs or more */
    | 'long calls'
    /** A call allocated 1 KiB or more */
    | 'allocating calls';

export interface GroupResult {
    readonly name: string;
    readonly lead: Lead;
    readonly leadReason: LeadReason;
    /** The timed rounds, in whole rotations of the variants' order */
    readonly rounds: number;
    readonly variants: readonly VariantResult[];
}

/** The options that a run's results record */
export interface RecordedOptions {
    readonly rounds: number;
    readonly warmupRounds: number;
    readonly sampleTime: number;
    readonly aa: boolean;
    readonly heap: boolean;
    /** The source of the regular expression that selected groups by name */
    readonly filter: string;
}

/** A run's results, which `JSON.stringify` writes as they are */
export interface RunResult {
    /** The version of this format, which changes when a field does */
    readonly schema: 1;
    /** When the run started, as an ISO 8601 string */
    readonly date: string;
    readonly runtime: RuntimeDescription;
    readonly options: RecordedOptions;
    readonly groups: readonly GroupResult[];
}
