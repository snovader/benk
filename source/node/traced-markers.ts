// What the traced run of `--v8-report` writes to its stdout among V8's
// traces, so that the process that runs it can place them: which `bench()`
// call each compilation and deoptimization was in, which group's timed
// rounds, and where each variant's `run` starts. A marker is a line of its
// own, which `parseTrace()` skips.
//
// V8 writes its traces on the main thread, while JavaScript waits, and the
// traced run compiles on it too. So a marker that JavaScript writes falls
// between two of V8's lines, rather than within one. Of 300 functions, each
// made hot between two markers, all 1,050 compilations and deoptimizations
// were between the right markers, on Node 24.22.3, 26.13.0 and
// 27.0.0-alpha on macOS.
import { writeSync } from 'node:fs';
import type { Role } from '#source/core/types';
import { parseTrace, type SourcePosition, type V8Trace } from './v8-trace.ts';

/** What starts a marker's line, before its JSON */
const PREFIX = 'benk-traced-run ';

/** A break between lines, as `v8-trace.ts` splits them */
const LINE_BREAK = /\r?\n/;

/** A variant as the traced run measured it */
export interface TracedVariant {
    /** Its name in the results */
    readonly name: string;
    readonly role: Role;
    /**
     * Where its `run` starts, as V8 places it, before any source map, or
     * null where the traced run couldn't read it
     */
    readonly run: SourcePosition | null;
}

/** A group as the traced run measured it */
export interface TracedGroup {
    readonly name: string;
    readonly variants: readonly TracedVariant[];
}

/**
 * A marker of the traced run, of the `bench()` call that it numbers from 0
 * in its process:
 *
 * - `start`: the call starts measuring.
 * - `timed` and `done`: its group, by its index in the results, starts its
 *   timed rounds, and is done with them.
 * - `end`: the call is done measuring.
 * - `variants`: its groups, after `end`.
 */
export type Marker =
    | { readonly bench: number; readonly event: 'start' | 'end' }
    | {
          readonly bench: number;
          readonly event: 'timed' | 'done';
          readonly group: number;
      }
    | {
          readonly bench: number;
          readonly event: 'variants';
          readonly groups: readonly TracedGroup[];
      };

/** What a traced run's stdout has of a `bench()` call of it */
export interface TracedBench {
    /** V8's traces from the call's start to its end */
    readonly trace: V8Trace;
    /**
     * The traces of each group's timed rounds, by the group's index: parts
     * of `trace`, with the same objects of its compilations and
     * deoptimizations
     */
    readonly timed: readonly V8Trace[];
    /** Its groups, as the run measured them, or none if it didn't say */
    readonly groups: readonly TracedGroup[] | undefined;
}

/** What a traced run's stdout has */
export interface TracedOutput {
    /** All of V8's traces */
    readonly trace: V8Trace;
    /** Each `bench()` call's, by its number */
    readonly benches: ReadonlyMap<number, TracedBench>;
}

/**
 * Writes a marker to stdout in the traced run, with a write of its own
 * rather than through `process.stdout`, which can hold a write back and
 * write it after V8's next lines
 */
export function writeMarker(marker: Marker): void {
    const bytes = Buffer.from(`${PREFIX}${JSON.stringify(marker)}\n`);

    let written = 0;
    while (written < bytes.length) {
        try {
            written += writeSync(1, bytes, written);
        } catch (error) {
            // A pipe that Node made non-blocking, as `process.stdout` does,
            // is full until the process that runs this one reads it
            if (!isAgain(error)) {
                throw error;
            }
        }
    }
}

/**
 * Reads V8's traces from a traced run's stdout, and places them by its
 * markers: each `bench()` call's, and each of its groups' timed rounds'
 */
export function readTracedOutput(output: string): TracedOutput {
    const segments = new Segments();

    for (const line of output.split(LINE_BREAK)) {
        const marker = markerOf(line);
        if (marker == null) {
            segments.add(line);
        } else {
            segments.mark(marker);
        }
    }

    return segments.build();
}

/** The marker of a line, or none if it isn't one */
function markerOf(line: string): Marker | undefined {
    if (!line.startsWith(PREFIX)) {
        return undefined;
    }

    try {
        // Written by `writeMarker()`, unless the script wrote the same start
        return JSON.parse(line.slice(PREFIX.length)) as Marker;
    } catch {
        return undefined;
    }
}

/** A part of the output between two markers, and where it is */
interface Segment {
    readonly bench: number | undefined;
    readonly group: number | undefined;
    readonly trace: V8Trace;
}

/** The parts of a traced run's output, as its lines come */
class Segments {
    readonly #segments: Segment[] = [];
    readonly #groups = new Map<number, readonly TracedGroup[]>();
    #lines: string[] = [];
    #bench: number | undefined;
    #group: number | undefined;

    add(line: string): void {
        this.#lines.push(line);
    }

    mark(marker: Marker): void {
        this.#close();

        switch (marker.event) {
            case 'start':
                this.#bench = marker.bench;
                break;
            case 'timed':
                this.#group = marker.group;
                break;
            case 'done':
                this.#group = undefined;
                break;
            case 'end':
                this.#bench = undefined;
                break;
            case 'variants':
                this.#groups.set(marker.bench, marker.groups);
                break;
        }
    }

    build(): TracedOutput {
        this.#close();

        const benches = new Map<number, TracedBench>();
        for (const bench of new Set(this.#segments.map(s => s.bench))) {
            if (bench != null) {
                benches.set(bench, this.#benchOf(bench));
            }
        }

        return {
            trace: joined(this.#segments.map(segment => segment.trace)),
            benches
        };
    }

    /**
     * Parses the lines since the last marker, which a compilation or a
     * deoptimization doesn't span, as V8 writes each while JavaScript waits
     */
    #close(): void {
        this.#segments.push({
            bench: this.#bench,
            group: this.#group,
            trace: parseTrace(this.#lines.join('\n'))
        });
        this.#lines = [];
    }

    #benchOf(bench: number): TracedBench {
        const segments = this.#segments.filter(s => s.bench === bench);
        const timed: V8Trace[] = [];
        for (const { group, trace } of segments) {
            if (group != null) {
                timed[group] = joined([timed[group] ?? EMPTY, trace]);
            }
        }

        return {
            trace: joined(segments.map(segment => segment.trace)),
            timed: Array.from(timed, trace => trace ?? EMPTY),
            groups: this.#groups.get(bench)
        };
    }
}

const EMPTY: V8Trace = { compilations: [], deoptimizations: [], turbofan: [] };

/** Traces one after another, as one */
function joined(traces: readonly V8Trace[]): V8Trace {
    return {
        compilations: traces.flatMap(trace => trace.compilations),
        deoptimizations: traces.flatMap(trace => trace.deoptimizations),
        turbofan: traces.flatMap(trace => trace.turbofan)
    };
}

function isAgain(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'EAGAIN';
}
