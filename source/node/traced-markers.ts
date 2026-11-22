// What the traced run of `--v8-report` writes to its stdout among V8's
// traces, so that the process that runs it can place them: which `bench()`
// call each compilation and deoptimization was in, which group's timed
// rounds, and where each variant's `run` starts. A marker is a line of its
// own, which the reader cuts out of the output before it parses V8's lines.
//
// V8 writes its traces on the main thread, while JavaScript waits, and the
// traced run compiles on it too. Where V8's stdout isn't buffered, a marker
// that JavaScript writes falls between two of V8's lines, after those that
// V8 wrote before it. Of 300 functions, each made hot between two markers,
// all 1,050 compilations and deoptimizations were between the right
// markers, on Node 24.22.3, 26.13.0 and 27.0.0-alpha on macOS. Where it's
// buffered, as on Windows, `markersInOrder()` says why the markers fall
// elsewhere, and the reader uses only what they say, not where they are.
import { writeSync } from 'node:fs';
import type { Role } from '#source/core/types';
import { parseTrace, type SourcePosition, type V8Trace } from './v8-trace.ts';

/** What starts a marker's line, before its JSON */
const PREFIX = 'benk-traced-run ';

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
    /**
     * V8's traces from the call's start to its end, or all of them where the
     * markers don't place them
     */
    readonly trace: V8Trace;
    /**
     * The traces of each group's timed rounds, by the group's index: parts
     * of `trace`, with the same objects of its compilations and
     * deoptimizations. None where the markers don't place them.
     */
    readonly timed: readonly V8Trace[] | undefined;
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
 * Whether the traced run's markers fall among V8's lines where V8 wrote
 * them. V8 prints its traces through the C runtime's `stdout`, whose
 * buffering Node turns off on POSIX only, in `src/node.cc`. On Windows, V8's
 * lines reach the pipe in chunks of that buffer, and a marker falls between
 * two chunks: before lines that V8 wrote before it, and often within one.
 * Node has no function that empties the buffer.
 */
export function markersInOrder(): boolean {
    return process.platform !== 'win32';
}

/**
 * Reads V8's traces from a traced run's stdout, with its markers cut out of
 * them, wherever they fall. Where the markers fall in order, it places the
 * traces by them: each `bench()` call's, and each of its groups' timed
 * rounds'. It doesn't where they don't, or where a marker fell within a
 * line of V8's, which shows that they didn't: each call then has all of the
 * traces, and none of timed rounds.
 */
export function readTracedOutput(
    output: string,
    inOrder: boolean = markersInOrder()
): TracedOutput {
    const { pieces, markers } = cutMarkers(output);
    const placed = inOrder && markers.every(marker => marker.atLineStart);
    const segments = new Segments(placed);

    for (const [i, { marker }] of markers.entries()) {
        segments.add(pieces[i]);
        segments.mark(marker);
    }
    segments.add(pieces[markers.length]);

    return segments.build();
}

/** A marker, and whether it starts a line of the output */
interface CutMarker {
    readonly marker: Marker;
    readonly atLineStart: boolean;
}

/**
 * The markers of an output, and the pieces of the output around them: the
 * text before each marker, and then the text after the last
 */
function cutMarkers(output: string): {
    pieces: string[];
    markers: CutMarker[];
} {
    const pieces: string[] = [];
    const markers: CutMarker[] = [];
    let from = 0;
    let atLineStart = true;

    for (
        let at = output.indexOf(PREFIX);
        at !== -1;
        at = output.indexOf(PREFIX, at + 1)
    ) {
        // A marker's JSON has no line break in it
        const end = output.indexOf('\n', at);
        const marker = markerOf(
            output.slice(at + PREFIX.length, end === -1 ? undefined : end)
        );
        if (marker == null) {
            continue;
        }

        const piece = output.slice(from, at);
        if (piece !== '') {
            atLineStart = piece.endsWith('\n');
        }
        pieces.push(piece);
        markers.push({ marker, atLineStart });
        from = end === -1 ? output.length : end + 1;
    }
    pieces.push(output.slice(from));

    return { pieces, markers };
}

/** The marker of a marker's JSON, or none if it isn't one */
function markerOf(json: string): Marker | undefined {
    try {
        // Written by `writeMarker()`, unless the script wrote the same start
        return JSON.parse(json) as Marker;
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

/**
 * The parts of a traced run's output between its markers, as they come, or
 * all of it as one, where the markers don't place it
 */
class Segments {
    readonly #placed: boolean;
    readonly #segments: Segment[] = [];
    readonly #groups = new Map<number, readonly TracedGroup[]>();
    readonly #benches = new Set<number>();
    #text = '';
    #bench: number | undefined;
    #group: number | undefined;

    constructor(placed: boolean) {
        this.#placed = placed;
    }

    add(text: string): void {
        this.#text += text;
    }

    mark(marker: Marker): void {
        this.#benches.add(marker.bench);
        if (!this.#placed) {
            if (marker.event === 'variants') {
                this.#groups.set(marker.bench, marker.groups);
            }
            return;
        }

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

        const trace = joined(this.#segments.map(segment => segment.trace));
        const benches = new Map<number, TracedBench>();
        for (const bench of this.#benches) {
            benches.set(
                bench,
                this.#placed
                    ? this.#benchOf(bench)
                    : {
                          trace,
                          timed: undefined,
                          groups: this.#groups.get(bench)
                      }
            );
        }

        return { trace, benches };
    }

    /**
     * Parses the text since the last marker, which a compilation or a
     * deoptimization doesn't span, as V8 writes each while JavaScript waits
     */
    #close(): void {
        this.#segments.push({
            bench: this.#bench,
            group: this.#group,
            trace: parseTrace(this.#text)
        });
        this.#text = '';
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
