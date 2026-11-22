// Parsers of what V8 writes in the traced run of `--v8-report`: the traces of
// its flags `--trace-opt`, `--trace-deopt-verbose` and `--trace-turbo-inlining`
// on stdout, and the log of `--log-code`. V8 doesn't keep their formats
// stable: these match V8 13.6, 14.6 and 15.6, of Node 24.22.3, 26.13.0 and
// 27.0.0-alpha, and d8 15.8.62.9, as the fixtures in `test/fixtures/v8` have
// them. They port the parsers of meteox's d8 tools, for V8 15.8, to these
// versions. d8 writes what Node's V8 writes, but names a script by its path.
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A function's identity in a process: the address of its
 * `SharedFunctionInfo`, untagged, in hexadecimal. The traces print it
 * tagged, one more than the log does, and V8 names anonymous functions alike.
 */
export type FunctionAddress = string;

/** A position in a script, with a line and column from 1, as V8 prints it */
export interface SourcePosition {
    /**
     * The script's URL, or '' for one compiled from a string. V8 names a
     * script that d8 loads, and a CommonJS module of Node's, by its path,
     * whose file's URL this is.
     */
    readonly url: string;
    readonly line: number;
    readonly column: number;
}

/** A compilation that completed, of `--trace-opt` */
export interface Compilation {
    readonly function: FunctionAddress;
    /** The function's name, or '' */
    readonly name: string;
    /** V8's name of the tier, such as `MAGLEV` or `TURBOFAN_JS` */
    readonly tier: string;
    /** Whether it compiled a running loop, for on-stack replacement */
    readonly osr: boolean;
}

/** A deoptimization, of `--trace-deopt-verbose` */
export interface Deoptimization {
    /** The function whose optimized code deoptimized */
    readonly function: FunctionAddress;
    readonly name: string;
    /** The tier of the code that deoptimized */
    readonly tier: string;
    /** `deopt-eager`, `deopt-lazy` or `deopt-soft` */
    readonly kind: string;
    readonly reason: string;
    /**
     * Where the code deoptimized, first, and then where each function that
     * it was in was inlined, outwards. Empty when V8 printed none.
     */
    readonly positions: readonly SourcePosition[];
}

/** A function that Turbofan considered inlining into one that it compiled */
export interface InliningCandidate {
    readonly function: FunctionAddress;
    readonly name: string;
    /** The size of its bytecode, when V8 printed it */
    readonly bytecodeSize: number | undefined;
    /** Whether Turbofan inlined it, at one of its calls at least */
    readonly inlined: boolean;
    /** Why it didn't, when V8 said */
    readonly reason: string | undefined;
}

/** A compilation by Turbofan, and its decisions of `--trace-turbo-inlining` */
export interface TurbofanCompilation {
    readonly function: FunctionAddress;
    readonly name: string;
    readonly osr: boolean;
    /** In the order that Turbofan first considered them */
    readonly candidates: readonly InliningCandidate[];
}

/** What V8's traces on stdout say of a run */
export interface V8Trace {
    readonly compilations: readonly Compilation[];
    readonly deoptimizations: readonly Deoptimization[];
    readonly turbofan: readonly TurbofanCompilation[];
}

/** A function of `--log-code`'s log, from the creation of its code */
export interface LoggedFunction {
    readonly function: FunctionAddress;
    /** Its name, or '' */
    readonly name: string;
    /** Whether it's a script's top level, rather than a function in it */
    readonly topLevel: boolean;
    /** Where it starts */
    readonly position: SourcePosition;
    /** The size of its bytecode, if the log has its creation */
    readonly bytecodeSize: number | undefined;
}

/**
 * A break between lines, which can be `\r\n` on Windows, where a C program's
 * stdout and files can be in text mode
 */
const LINE_BREAK = /\r?\n/;

/**
 * An address, as V8 prints it: in lower case after `0x` where it formats the
 * address itself, and as the C library's `%p` or a stream's `void*` where
 * it doesn't, as in `(sfi = %p)` and the handles of the inlining's lines.
 * Those have `0x` on macOS and Linux, and on Windows neither `0x` nor lower
 * case, as `000002A3B4C5D6E7`.
 */
const ADDRESS = String.raw`(?:0x)?[\dA-Fa-f]+`;

/**
 * A `JSFunction` as the traces print it, as
 * `<JSFunction sum (sfi = 0x121eeab5b611)>`, which captures its name and
 * address
 */
const JS_FUNCTION = String.raw`<JSFunction (.*?) ?\(sfi = (${ADDRESS})\)>`;

/**
 * A `SharedFunctionInfo` as the inlining's lines print it, after a handle's
 * address, as `0x7884e9b5c8 {0x121eeab5b611 <SharedFunctionInfo sum>}`,
 * which captures its address and name
 */
const SHARED = String.raw`${ADDRESS} \{(${ADDRESS}) <SharedFunctionInfo ?(.*?)>\}`;

/**
 * The start of a compilation, as `[compiling method 0x… <JSFunction …>
 * (target TURBOFAN_JS) OSR, mode: ConcurrencyMode::kSynchronous]`
 */
const COMPILING = new RegExp(
    String.raw`^\[compiling method ${ADDRESS} ${JS_FUNCTION} \(target (\w+)\)( OSR)?`
);

/**
 * A compilation that completed, as `[completed compiling 0x… <JSFunction …>
 * (target MAGLEV) - took 0.000, 0.150, 0.001 ms]`
 */
const COMPLETED = new RegExp(
    String.raw`^\[completed compiling ${ADDRESS} ${JS_FUNCTION} \(target (\w+)\)( OSR)?`
);

/**
 * A deoptimization's first line, as `[bailout (kind: deopt-eager, reason:
 * wrong map): begin. deoptimizing 0x… <JSFunction …>, 0x… <Code MAGLEV>, …]`
 */
const BAILOUT = new RegExp(
    String.raw`^\[bailout \(kind: ([\w-]+), reason: (.*?)\): begin\. deoptimizing ${ADDRESS} ${JS_FUNCTION}, ${ADDRESS} <Code (\w+)>`
);

/**
 * A deoptimization's positions, as `;;; deoptimize at <file:///bench.ts:17:29>
 * inlined at <file:///bench.ts:90:15>`
 */
const DEOPTIMIZE_AT = /^\s+;;; deoptimize at (<.*>)/;

/** A position of a deoptimization, which captures its URL, line and column */
const POSITION = /<(.*?):(\d+):(\d+)>/g;

/** What a deoptimization's position names a script without a URL by */
const UNKNOWN_SCRIPT = 'unknown';

/** A candidate for inlining, as `Considering 0x… {…} for inlining with …` */
const CONSIDERING = new RegExp(`^Considering ${SHARED} for inlining`);

/** A candidate's bytecode size, as `  - target: 0x… {…}, bytecode size: 38` */
const TARGET = new RegExp(
    String.raw`^ {2}- target: ${SHARED}, (?:bytecode size: (\d+)|no bytecode)`
);

/** An inlining, as `Inlining 0x… {…} into 0x… {…}` */
const INLINING = new RegExp(`^Inlining ${SHARED} into ${SHARED}`);

/**
 * A candidate that Turbofan won't inline, with the reason, as `Cannot consider
 * 0x… {…} for inlining (reason: exceeds bytecode limit)`
 */
const CANNOT_CONSIDER = new RegExp(
    String.raw`^(?:Cannot|Not) consider(?:ing)? ${SHARED} for inlining \((?:reason: )?(.*)\)$`
);

/**
 * A candidate that Turbofan won't inline into a function, as `Not inlining
 * 0x… {…} into 0x… {…} because callee is a class constructor.`
 */
const NOT_INLINING = new RegExp(
    String.raw`^Not inlining ${SHARED} into ${SHARED} because (.*?)\.?$`
);

/**
 * A function's name and position in the code log, as `sum
 * file:///bench.ts:15:13`, which captures them. A script is named by its URL,
 * without spaces, or by its absolute path, as d8 names it, which can have
 * spaces as a name can. The name is the shortest that leaves a script after
 * it, so a name with a space before a `/` takes what follows for a path.
 */
const LOGGED_POSITION = /^(.*?) ((?:\/|[A-Za-z]:[\\/]).*|\S*):(\d+):(\d+)$/;

/**
 * The log's line of V8's version, as `v8-version,15,8,62,9,0`, or with the
 * embedder's string, as Node's `v8-version,14,6,202,34,-node.40,0`, which
 * captures the version's numbers and the embedder's string
 */
const LOGGED_VERSION =
    /^v8-version,(\d+),(\d+),(\d+),(\d+),(?:([^,\r\n]*),)?\d+\r?$/m;

/**
 * An escape of V8's log, after its backslash: a comma's is `x2C`, and others'
 * are in lower case
 */
const LOG_ESCAPE = /\\(x[\dA-Fa-f]{2}|u[\dA-Fa-f]{4}|n|\\)/g;

/**
 * V8 13.6's reasons that a function can't be inlined, which it prints by
 * their number in `SharedFunctionInfo::Inlineability`, in the order of
 * V8 13.6.233.17's source, with the words that V8 14.6 prints for them
 */
const INLINEABILITY = [
    'has no script',
    'needs binary coverage',
    'is builtin',
    'is not user code',
    'has no bytecode',
    'exceeds bytecode limit',
    'may contain breakpoints',
    'has optimization disabled'
];

/**
 * Reads V8's traces from a traced run's stdout, and skips its other lines.
 * A Turbofan compilation's lines of inlining are those between the lines
 * that start and complete it, as the traced run compiles on the main thread.
 */
export function parseTrace(output: string): V8Trace {
    const lines = output.split(LINE_BREAK);
    const compilations: Compilation[] = [];
    const deoptimizations: Deoptimization[] = [];
    const turbofan: TurbofanBuilder[] = [];
    let current: TurbofanBuilder | undefined;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const compiling = COMPILING.exec(line);
        if (compiling != null) {
            current = undefined;
            if (compiling[3] === 'TURBOFAN_JS') {
                current = new TurbofanBuilder(compiling);
                turbofan.push(current);
            }
            continue;
        }

        const completed = COMPLETED.exec(line);
        if (completed != null) {
            current = undefined;
            compilations.push(compilationOf(completed));
            continue;
        }

        const bailout = BAILOUT.exec(line);
        if (bailout != null) {
            deoptimizations.push(deoptimizationOf(bailout, lines, i + 1));
            continue;
        }

        current?.read(line);
    }

    return {
        compilations,
        deoptimizations,
        turbofan: turbofan.map(builder => builder.build())
    };
}

/**
 * Reads the functions of `--log-code`'s log, from the creation of their
 * code. The size of their bytecode is that of its creation, which `~`
 * marks, and which the log has only of functions compiled while it logs,
 * not of Node's from its snapshot. It's the bytecode's length, which
 * Turbofan's budgets for inlining count.
 */
export function parseCodeLog(
    log: string
): Map<FunctionAddress, LoggedFunction> {
    const functions = new Map<FunctionAddress, LoggedFunction>();

    for (const line of log.split(LINE_BREAK)) {
        const logged = loggedFunctionOf(line);
        if (logged != null) {
            const known = functions.get(logged.function);
            functions.set(
                logged.function,
                known == null ? logged : merged(known, logged)
            );
        }
    }

    return functions;
}

/**
 * A function of two lines of the log: a script's top level is of the type
 * `Script` in its bytecode's line, and of `JS` in its optimized code's, and
 * only the bytecode's line has its size
 */
function merged(known: LoggedFunction, logged: LoggedFunction): LoggedFunction {
    return {
        ...logged,
        topLevel: known.topLevel || logged.topLevel,
        bytecodeSize: logged.bytecodeSize ?? known.bytecodeSize
    };
}

/** The compilation of a match of `COMPLETED` */
function compilationOf(match: RegExpExecArray): Compilation {
    const [, name, address, tier, osr] = match;

    return { function: untagged(address), name, tier, osr: osr != null };
}

/**
 * The deoptimization of a match of `BAILOUT`, with the positions of the
 * lines of its block, from the line after the match's
 */
function deoptimizationOf(
    match: RegExpExecArray,
    lines: readonly string[],
    from: number
): Deoptimization {
    const [, kind, reason, name, address, tier] = match;

    return {
        function: untagged(address),
        name,
        tier,
        kind,
        reason,
        positions: positionsAfter(lines, from)
    };
}

/**
 * The positions of a deoptimization's line of `;;; deoptimize at`, which
 * comes before the line of `[bailout end` that ends its block, and is the
 * next line in the versions checked
 */
function positionsAfter(
    lines: readonly string[],
    from: number
): SourcePosition[] {
    for (let i = from; i < lines.length; i++) {
        if (lines[i].startsWith('[bailout')) {
            break;
        }

        const at = DEOPTIMIZE_AT.exec(lines[i]);
        if (at != null) {
            return positionsOf(at[1]);
        }
    }

    return [];
}

/**
 * The positions of a line of `;;; deoptimize at`, as
 * `<file:///bench.ts:1:30> inlined at <file:///bench.ts:2:67>`
 */
function positionsOf(text: string): SourcePosition[] {
    return Array.from(text.matchAll(POSITION), ([, url, line, column]) => ({
        url: url === UNKNOWN_SCRIPT ? '' : scriptUrl(url),
        line: Number(line),
        column: Number(column)
    }));
}

/**
 * The URL of a script as V8 names it: its file's URL where V8 names it by
 * its absolute path, as d8 and Node's CommonJS modules, and the name itself
 * otherwise. The traces come from this machine, whose paths these are.
 */
function scriptUrl(name: string): string {
    return isAbsolute(name) ? pathToFileURL(name).href : name;
}

/** The decisions of one Turbofan compilation, as its lines come */
class TurbofanBuilder {
    readonly #function: FunctionAddress;
    readonly #name: string;
    readonly #osr: boolean;
    readonly #candidates = new Map<FunctionAddress, CandidateBuilder>();

    constructor([, name, address, , osr]: RegExpExecArray) {
        this.#function = untagged(address);
        this.#name = name;
        this.#osr = osr != null;
    }

    /** Reads a line of the compilation, if it's one of inlining */
    read(line: string): void {
        const inlining = INLINING.exec(line);
        if (inlining != null) {
            this.#candidate(inlining).inlined = true;
            return;
        }

        const target = TARGET.exec(line);
        if (target != null) {
            const size = target[3];
            this.#candidate(target).bytecodeSize =
                size == null ? undefined : Number(size);
            return;
        }

        const considering = CONSIDERING.exec(line);
        if (considering != null) {
            this.#candidate(considering);
            return;
        }

        const rejection = CANNOT_CONSIDER.exec(line) ?? NOT_INLINING.exec(line);
        if (rejection != null) {
            this.#candidate(rejection).reason = reasonOf(
                rejection[rejection.length - 1]
            );
        }
    }

    build(): TurbofanCompilation {
        return {
            function: this.#function,
            name: this.#name,
            osr: this.#osr,
            candidates: Array.from(this.#candidates.values(), candidate => ({
                ...candidate
            }))
        };
    }

    /** The candidate whose address and name a match captures first */
    #candidate([, address, name]: RegExpExecArray): CandidateBuilder {
        const key = untagged(address);
        let candidate = this.#candidates.get(key);
        if (candidate == null) {
            candidate = {
                function: key,
                name,
                bytecodeSize: undefined,
                inlined: false,
                reason: undefined
            };
            this.#candidates.set(key, candidate);
        }

        return candidate;
    }
}

type CandidateBuilder = {
    -readonly [Key in keyof InliningCandidate]: InliningCandidate[Key];
};

/** A reason in words, of V8 13.6's number or of a later version's words */
function reasonOf(reason: string | undefined): string | undefined {
    return reason != null && /^\d+$/.test(reason)
        ? (INLINEABILITY[Number(reason)] ?? `reason ${reason}`)
        : reason;
}

/**
 * V8's version, from its line in `--log-code`'s log, with the embedder's
 * string, as `15.8.62.9` of d8, and `14.6.202.34-node.40` of Node 26.13.0,
 * or undefined if the log has none
 */
export function parseLoggedVersion(log: string): string | undefined {
    const match = LOGGED_VERSION.exec(log);
    if (match == null) {
        return undefined;
    }

    const [, major, minor, build, patch, embedder] = match;
    return `${major}.${minor}.${build}.${patch}${embedder ?? ''}`;
}

/**
 * The function of a line of the code log that creates a function's code, as
 * `code-creation,JS,10,69581,0x1e373e4149c0,38,sumLoop file:///bench.ts:6:17,0x296851e78018,~`,
 * whose fields are the code's type, kind, time, address and size, the
 * function's name and position, its `SharedFunctionInfo`'s address, and
 * the mark of the code's tier
 */
function loggedFunctionOf(line: string): LoggedFunction | undefined {
    if (!line.startsWith('code-creation,')) {
        return undefined;
    }

    const fields = line.split(',');
    const [, type, , , , size] = fields;
    if (type !== 'JS' && type !== 'Script') {
        return undefined;
    }

    // The log writes the name as it is, with any commas in it, and escapes
    // the script's URL, which a space separates from it
    const described = fields.slice(6, -2).join(',');
    const [address, mark] = fields.slice(-2);
    const located = LOGGED_POSITION.exec(described);
    if (located == null) {
        return undefined;
    }

    const [, name, url, row, column] = located;
    return {
        function: untagged(address),
        name,
        topLevel: type === 'Script',
        position: {
            url: scriptUrl(unescapeLog(url)),
            line: Number(row),
            column: Number(column)
        },
        bytecodeSize: mark === '~' ? Number(size) : undefined
    };
}

/**
 * A string of V8's log as it was: the log escapes a comma as `\x2C`, a
 * backslash as `\\`, a line break as `\n`, another character up to 0xFF
 * that isn't printable as `\xHH`, and one beyond as the UTF-16 unit
 * `\uHHHH`
 */
function unescapeLog(text: string): string {
    return text.replaceAll(LOG_ESCAPE, (_, escape: string) => {
        if (escape === 'n') {
            return '\n';
        }
        if (escape === '\\') {
            return '\\';
        }

        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    });
}

/**
 * An address without its tag, in lower case after `0x`: the traces print a
 * heap object's address with the tag of 1 that V8 sets in its pointers, and
 * the log without, and Windows prints some without `0x`
 */
function untagged(address: string): FunctionAddress {
    const hex = address.startsWith('0x') ? address : `0x${address}`;

    return `0x${(BigInt(hex) & ~3n).toString(16)}`;
}
