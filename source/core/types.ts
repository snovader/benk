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
     *
     * The timer loop calls it as a function of its own, without the variant
     * as `this`, so that nothing but the call is in the loop. A method that
     * reads `this` needs binding, or an arrow function around it.
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
    /** Called without the variant as `this`, as a `SyncVariant`'s is */
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

/**
 * Counts the bytes of array buffers' contents that a runtime keeps outside
 * its heap, as V8 does for a buffer of more than 64 bytes. Where the runtime
 * can't tell how many it freed meanwhile, a sample counts nothing, and the
 * core takes another of fewer calls.
 */
export interface ArrayBufferMeter {
    /**
     * Waits, before a sample, for the runtime to free buffers that it frees
     * in the background, as V8 does after a garbage collection
     */
    settle(): Promise<void>;
    /**
     * Starts counting, and returns the function that stops and returns the
     * bytes allocated since, or null if buffers were freed meanwhile, as a
     * garbage collection frees them
     */
    start(): () => number | null;
}

/**
 * What a run's results record about the runtime that timed it. A runtime
 * that can't know one of them, as a Worker can't its processor, gives
 * `'unknown'`.
 */
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
     * as Node's `'benk from TypeScript source'`
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
    /**
     * Counts the bytes of array buffers outside the heap, where the runtime
     * can. A runtime without it counts none, as one written before it.
     */
    readonly arrayBuffers?: ArrayBufferMeter;
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
    /**
     * The bytes of array buffers' contents that a call allocated outside the
     * heap, which `heapBytes` leaves out. It's null where the runtime can't
     * count them or the run didn't, and where too few samples could be
     * counted, as when each call starts a garbage collection.
     */
    readonly arrayBufferBytes: number | null;
    /**
     * What V8 did with the variant's code in the traced run of
     * `--v8-report`, as `VariantV8` describes. It's null where no report was
     * made: without `--v8-report`, from `measureGroups()` and
     * `measureGroup()`, in d8, and where the traced run had no group or
     * variant of the same name.
     */
    readonly v8: VariantV8 | null;
}

/** Why a group's ratios compare the statistic that they do */
export type LeadReason =
    /** The group set it */
    | 'set'
    /**
     * Every call took under 1 µs and allocated under 1 KiB, on the heap and
     * in array buffers together
     */
    | 'short calls'
    /** A call took 1 µs or more */
    | 'long calls'
    /** A call allocated 1 KiB or more, on the heap and in array buffers */
    | 'allocating calls';

export interface GroupResult {
    readonly name: string;
    readonly lead: Lead;
    readonly leadReason: LeadReason;
    /** The timed rounds, in whole rotations of the variants' order */
    readonly rounds: number;
    /**
     * The resolution of the runtime's timer loops in nanoseconds, as benk
     * estimates it: the shortest time other than 0 that a timer loop of
     * empty calls read. That's the tick of a coarse clock. Where the clock
     * is finer than such a loop, as Node's is, it's the loop's own time,
     * which is longer than the tick. It's null where no such loop read
     * time, as with a virtual clock that only a variant's calls move.
     */
    readonly timerResolution: number | null;
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
    readonly schema: 4;
    /** When the run started, as an ISO 8601 string */
    readonly date: string;
    readonly runtime: RuntimeDescription;
    readonly options: RecordedOptions;
    readonly groups: readonly GroupResult[];
    /**
     * V8's report of the run's traced run, which Node's `bench()` makes with
     * `--v8-report`. It's null where no report was made: without the
     * option, from `measureGroups()`, and in d8.
     */
    readonly v8Report: V8Report | null;
}

// V8's report, from a traced run of the script in another process, which
// only Node's `bench()` makes. Its fields are plain data too: a size or a
// position that V8 didn't give is null.

/** A position in a script, with a line and column from 1 */
export interface V8Position {
    /** The script's URL, or '' for code compiled from a string */
    readonly url: string;
    readonly line: number;
    readonly column: number;
}

/** A function, as V8's code log describes it */
export interface V8Function {
    /** Its name, or '' */
    readonly name: string;
    /** Whether it's a script's top level, rather than a function in it */
    readonly topLevel: boolean;
    /**
     * Where it starts, in the source that its script's source map names, or
     * null where V8's log hasn't the function
     */
    readonly position: V8Position | null;
    /** The size of its bytecode, which Turbofan's limits count */
    readonly bytecodeSize: number | null;
}

/** Something that happened, and how many times */
export type V8Counted<T> = T & { readonly count: number };

/** A tier that V8 compiled a function to */
export interface V8Tier {
    /** V8's name of the tier, such as `MAGLEV` or `TURBOFAN_JS` */
    readonly tier: string;
    /** Whether it compiled a running loop, for on-stack replacement */
    readonly osr: boolean;
}

/** Turbofan's decision whether to inline a function into another */
export interface V8Inlining {
    /** The other function: the one called, or the one compiled */
    readonly function: V8Function;
    readonly inlined: boolean;
    /** Why it didn't, where V8 said */
    readonly reason: string | null;
}

/** A deoptimization of a function's optimized code */
export interface V8Deoptimization {
    /** The tier of the code that deoptimized */
    readonly tier: string;
    /** `deopt-eager`, `deopt-lazy` or `deopt-soft` */
    readonly kind: string;
    readonly reason: string;
    /**
     * Where it deoptimized, and then where each function that it was in was
     * inlined, outwards
     */
    readonly positions: readonly V8Position[];
}

/** What V8 did with a function in the traced run */
export interface V8FunctionReport extends V8Function {
    readonly tiers: ReadonlyArray<V8Counted<V8Tier>>;
    readonly deoptimizations: ReadonlyArray<V8Counted<V8Deoptimization>>;
    /**
     * Its Turbofan compilations' decisions of the functions that it calls,
     * counted by compilation
     */
    readonly callees: ReadonlyArray<V8Counted<V8Inlining>>;
    /** Other functions' Turbofan compilations' decisions of this one */
    readonly callers: ReadonlyArray<V8Counted<V8Inlining>>;
}

/** A variant, by its group's name and its own */
export interface V8VariantName {
    readonly group: string;
    readonly variant: string;
}

/** A deoptimization of a variant's code, and how many were in timed rounds */
export interface V8VariantDeoptimization extends V8Deoptimization {
    /** Whose code deoptimized: the variant's `run`'s, or a timer loop's */
    readonly code: 'run' | 'loop';
    readonly count: number;
    /** How many of them were in the timed rounds of the variant's group */
    readonly timed: number;
}

/**
 * What V8 did with a variant's code in the traced run, of the `bench()`
 * call that measured it. The traced run reads where each variant's `run`
 * starts. Its timer loops are those that the traces tie to that `run`: a
 * loop whose Turbofan compilation considered it, or whose deoptimization was
 * in it. Others, such as a loop that only Maglev compiled and that didn't
 * deoptimize, aren't counted. Variants with the same `run`, as a group's
 * reference and its A/A copy, share their loops.
 */
export interface VariantV8 {
    /**
     * Its `run`, or null where the traced run couldn't place it, as a
     * builtin, or V8's log hasn't a function there
     */
    readonly run: V8Function | null;
    /** The tiers that V8 compiled its `run` to, on its own */
    readonly runTiers: ReadonlyArray<V8Counted<V8Tier>>;
    /** Its timer loops that the traces tie to its `run` */
    readonly loops: number;
    /** The tiers that V8 compiled those loops to */
    readonly loopTiers: ReadonlyArray<V8Counted<V8Tier>>;
    /**
     * Turbofan's decisions in its loops' compilations: what it inlined into
     * them, its `run` too, and what it didn't
     */
    readonly inlining: ReadonlyArray<V8Counted<V8Inlining>>;
    /** The deoptimizations of its `run`'s code, and of its loops' */
    readonly deoptimizations: readonly V8VariantDeoptimization[];
    /**
     * The other variants of the `bench()` call whose `run` is the same
     * function, and whose loops these are too
     */
    readonly sharedWith: readonly V8VariantName[];
}

/**
 * Turbofan's limits on inlining, from V8's flags, in bytes of bytecode, as
 * the Node that ran the script has them
 */
export interface InliningLimits {
    /** `--max-inlined-bytecode-size`: a function that Turbofan inlines */
    readonly maxInlinedBytecodeSize: number;
    /**
     * `--max-inlined-bytecode-size-cumulative`: the functions that one
     * compilation inlines, in all
     */
    readonly maxInlinedBytecodeSizeCumulative: number;
    /**
     * `--max-inlined-bytecode-size-small`: a small function, which Turbofan
     * inlines beyond the cumulative limit
     */
    readonly maxInlinedBytecodeSizeSmall: number;
}

/**
 * A function of the script whose bytecode is over a limit: Turbofan's, for
 * a function that it considered inlining, or the user's, for a function that
 * it compiled or considered
 */
export interface V8SizeFailure {
    readonly kind: 'over budget' | 'over limit';
    readonly function: V8Function;
    /** The limit, in bytes of bytecode */
    readonly limit: number;
    /** The functions whose Turbofan compilations considered inlining it */
    readonly consideredFor: readonly V8Function[];
}

/** A deoptimization in a group's timed rounds, of the script's code */
export interface V8DeoptimizationFailure {
    readonly kind: 'deoptimized';
    readonly group: string;
    /** The function whose code deoptimized */
    readonly function: V8Function;
    readonly deoptimization: V8Deoptimization;
    readonly count: number;
}

export type V8Failure = V8SizeFailure | V8DeoptimizationFailure;

/** The check of `--v8-check`, of the functions that the report lists */
export interface V8Check {
    /** Whether no function failed it */
    readonly passed: boolean;
    /** The user's limit of `--v8-max-bytecode`, or null */
    readonly maxBytecodeSize: number | null;
    readonly failures: readonly V8Failure[];
}

/** V8's report of a run, from its traced run */
export interface V8Report {
    /** The path of the script that was traced */
    readonly script: string;
    /** The source of `--v8-filter`, or '' */
    readonly filter: string;
    /** Turbofan's limits, or null where `node --v8-options` didn't give them */
    readonly limits: InliningLimits | null;
    /** The functions that the report lists, as its text does */
    readonly functions: readonly V8FunctionReport[];
    /** The check of `--v8-check`, or null without it */
    readonly check: V8Check | null;
}
