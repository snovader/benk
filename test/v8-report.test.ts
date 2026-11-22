// The V8 report: which functions it lists, and how it writes them, on the
// fixtures' traced runs and on traces made up to cover what they don't
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { formatV8Report, reportFunctions, type FunctionReport } from '#source/node/v8-report';
import type {
    Compilation,
    Deoptimization,
    LoggedFunction,
    SourcePosition,
    TurbofanCompilation,
    V8Trace
} from '#source/node/v8-trace';
import { traced, BENCH, REPOSITORY, VERSIONS } from './v8-fixtures.ts';

/** benk's directory in the fixtures, as `capture.ts` loaded it from its source */
const BENK_SOURCE = `${pathToFileURL(join(REPOSITORY, 'source')).href}/`;

const FORMAT = { script: join(REPOSITORY, BENCH), directory: REPOSITORY };

/** The lines of a function of a report, from its first line to the next function's */
function linesOf(lines: readonly string[], first: string): string[] {
    const from = lines.indexOf(first);
    expect(from, `Expected the report to have "${first}"`).not.toBe(-1);

    const to = lines.findIndex((line, i) => i > from && !line.startsWith('  '));
    return lines.slice(from, to === -1 ? undefined : to);
}

describe.each(VERSIONS)('the report of the traced run on Node %s', version => {
    const { trace, logged } = traced(version);
    const reports = reportFunctions(trace, logged, { benkDirectory: BENK_SOURCE });
    const lines = formatV8Report(reports, FORMAT);

    it("lists the script's functions by position, then other functions that deoptimized in its code", () => {
        const names = reports.map(({ name, topLevel, position }) => [
            topLevel ? '(top level)' : name,
            position?.line,
            position?.column
        ]);
        const scripts = names.slice(0, 11);

        expect(scripts).toStrictEqual([
            ['(top level)', 1, 1],
            ['', 7, 47],
            ['', 8, 46],
            ['sum', 15, 13],
            ['mix', 23, 13],
            ['mixAll', 64, 16],
            ['mean, μ', 73, 12],
            ['run', 80, 9],
            ['run', 84, 9],
            ['run', 90, 9],
            ['run', 94, 9]
        ]);
        // The timer loops, which `new Function` compiles from strings
        for (const [name, line, column] of names.slice(11)) {
            expect([name, line, column]).toStrictEqual(['', 1, 20]);
        }
    });

    it('writes what Turbofan inlined, with sizes of bytecode, and the deoptimizations', () => {
        expect(linesOf(lines, `mix ${BENCH}:23:13, 874 B of bytecode`)).toStrictEqual([
            `mix ${BENCH}:23:13, 874 B of bytecode`,
            '  compiled to Maglev ×2, Turbofan ×2',
            `  not inlined into mixAll ${BENCH}:64:16: exceeds bytecode limit ×2`,
            `  deoptimized in Turbofan's code: not a Smi (eager), at ${BENCH}:24:15`
        ]);

        // Its bytecode is a byte longer in V8 14.6 than in 13.6 and 15.6
        const mixAll = `mixAll ${BENCH}:64:16, ${version.startsWith('26.') ? 47 : 46} B of bytecode`;
        expect(linesOf(lines, mixAll)).toStrictEqual([
            mixAll,
            '  compiled to Maglev ×2, Turbofan ×2',
            `  doesn't inline mix ${BENCH}:23:13 (874 B): exceeds bytecode limit ×2`,
            `  deoptimized in Turbofan's code: wrong map (eager), at ${BENCH}:66:29`
        ]);
    });

    it('writes a script without a URL, as of a timer loop, as <anonymous>', () => {
        const loops = lines.filter(line => line.startsWith('(anonymous) <anonymous>:1:20, '));

        expect(loops).toHaveLength(reports.length - 11);
        expect(lines.some(line => line.includes(`, inlined at <anonymous>:`))).toBe(true);
    });
});

describe('formatV8Report', () => {
    it('says which script the report is of, and when none of its functions was optimized', () => {
        expect(formatV8Report([], FORMAT)).toStrictEqual([
            '',
            `V8 report of ${BENCH}, from a run of it with V8's traces, whose times aren't reported.`,
            "Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.",
            '  No function of the script was optimized.'
        ]);
    });

    it('counts lines alike together, as of the timer loops that inline a function', () => {
        const loop = (address: string): FunctionReport['callers'][number]['value']['other'] => ({
            function: address,
            name: '',
            topLevel: false,
            position: { url: '', line: 1, column: 20 },
            bytecodeSize: 72
        });
        const report: FunctionReport = {
            function: '0x10',
            name: 'run',
            topLevel: false,
            position: { url: 'node:test', line: 2, column: 3 },
            bytecodeSize: 13,
            tiers: [],
            deoptimizations: [],
            callees: [],
            callers: [
                { value: { other: loop('0x20'), inlined: true, reason: undefined }, count: 1 },
                { value: { other: loop('0x30'), inlined: true, reason: undefined }, count: 2 }
            ]
        };

        expect(formatV8Report([report], FORMAT).slice(3)).toStrictEqual([
            'run node:test:2:3, 13 B of bytecode',
            '  inlined into (anonymous) <anonymous>:1:20 ×3'
        ]);
    });

    it("writes Node's modules by their URLs, and on-stack replacement as OSR", () => {
        const report: FunctionReport = {
            function: '0x10',
            name: 'normalizeString',
            topLevel: false,
            position: { url: 'node:path', line: 69, column: 30 },
            bytecodeSize: undefined,
            tiers: [{ value: { tier: 'MAGLEV', osr: true }, count: 1 }],
            deoptimizations: [],
            callees: [],
            callers: []
        };

        expect(formatV8Report([report], FORMAT).slice(3)).toStrictEqual([
            'normalizeString node:path:69:30',
            '  compiled to Maglev (OSR)'
        ]);
    });
});

// Traces made up of functions in the script, in Node, in benk and in strings,
// which the code log has, or not

const BENK = 'file:///project/node_modules/benk/dist/';
const URLS = [
    'file:///project/bench.ts',
    'file:///project/sum.ts',
    'node:path',
    `${BENK}index.js`,
    ''
];

/** Whether a script is the benchmark's own, which the report lists functions of */
function isScript(url: string): boolean {
    return url !== '' && !url.startsWith('node:') && !url.startsWith(BENK);
}

const positions = fc.record({
    url: fc.constantFrom(...URLS),
    line: fc.integer({ min: 1, max: 9 }),
    column: fc.integer({ min: 1, max: 9 })
});

/** Functions at distinct addresses, the first ones of which the code log has */
const functions = fc
    .uniqueArray(fc.integer({ min: 1, max: 0xffff }), { minLength: 1, maxLength: 12 })
    .chain(numbers =>
        fc.tuple(
            fc.tuple(
                ...numbers.map(number =>
                    fc.record({
                        function: fc.constant(`0x${(number * 8).toString(16)}`),
                        name: fc.constantFrom('', 'sum', 'run'),
                        topLevel: fc.boolean(),
                        position: positions,
                        bytecodeSize: fc.option(fc.integer({ min: 1, max: 999 }), {
                            nil: undefined
                        })
                    })
                )
            ),
            fc.nat(numbers.length)
        )
    );

/** A run's traces of its functions, and its log of them, without the last ones */
const runs = functions.chain(([all, unlogged]) => {
    const named = fc.nat(all.length - 1).map(i => all[i]);
    const trace = fc.record({
        compilations: fc.array(compilations(named)),
        deoptimizations: fc.array(deoptimizations(named)),
        turbofan: fc.array(turbofanCompilations(named))
    });
    const logged = new Map<string, LoggedFunction>(
        all.slice(0, all.length - unlogged).map(fn => [fn.function, fn])
    );

    return trace.map(made => ({ trace: made, logged }));
});

function compilations(traced: fc.Arbitrary<LoggedFunction>): fc.Arbitrary<Compilation> {
    return fc
        .record({ fn: traced, tier: fc.constantFrom('MAGLEV', 'TURBOFAN_JS'), osr: fc.boolean() })
        .map(({ fn, tier, osr }) => ({ function: fn.function, name: fn.name, tier, osr }));
}

function deoptimizations(traced: fc.Arbitrary<LoggedFunction>): fc.Arbitrary<Deoptimization> {
    return fc
        .record({ fn: traced, at: fc.array(positions, { maxLength: 3 }) })
        .map(({ fn, at }) => ({
            function: fn.function,
            name: fn.name,
            tier: 'MAGLEV',
            kind: 'deopt-eager',
            reason: 'wrong map',
            positions: at
        }));
}

function turbofanCompilations(
    traced: fc.Arbitrary<LoggedFunction>
): fc.Arbitrary<TurbofanCompilation> {
    const candidate = fc.record({ fn: traced, inlined: fc.boolean() }).map(({ fn, inlined }) => ({
        function: fn.function,
        name: fn.name,
        bytecodeSize: fn.bytecodeSize,
        inlined,
        reason: inlined ? undefined : 'exceeds bytecode limit'
    }));
    const candidates = fc.uniqueArray(candidate, { selector: ({ function: fn }) => fn });

    return fc.record({ fn: traced, candidates }).map(({ fn, candidates: considered }) => ({
        function: fn.function,
        name: fn.name,
        osr: false,
        candidates: considered
    }));
}

function report({
    trace,
    logged
}: {
    trace: V8Trace;
    logged: Map<string, LoggedFunction>;
}): FunctionReport[] {
    return reportFunctions(trace, logged, { benkDirectory: BENK });
}

/** The addresses of a trace's functions, of each kind of line */
function tracedFunctions(trace: V8Trace): Set<string> {
    return new Set([
        ...trace.compilations.map(compilation => compilation.function),
        ...trace.deoptimizations.map(deoptimization => deoptimization.function),
        ...trace.turbofan.flatMap(({ function: fn, candidates }) => [
            fn,
            ...candidates.map(c => c.function)
        ])
    ]);
}

describe('reportFunctions', () => {
    it.prop([runs])(
        "lists the script's functions that the log has, and others that deoptimized in the script's code",
        run => {
            const expected = Array.from(tracedFunctions(run.trace)).filter(address => {
                const position = run.logged.get(address)?.position;
                const deoptimizedInScript = run.trace.deoptimizations.some(
                    deoptimization =>
                        deoptimization.function === address &&
                        deoptimization.positions.some(at => isScript(at.url))
                );

                return position != null && (isScript(position.url) || deoptimizedInScript);
            });

            const listed = report(run).map(fn => fn.function);
            expect(listed.toSorted()).toStrictEqual(expected.toSorted());
        }
    );

    it.prop([runs])("orders the script's functions first, and each by its position", run => {
        const keys = report(run).map(({ position }) => {
            const { url, line, column } = position as SourcePosition;
            return [isScript(url) ? 0 : 1, url, line, column] as const;
        });

        for (let i = 1; i < keys.length; i++) {
            const [group, url, line, column] = keys[i - 1];
            const [nextGroup, nextUrl, nextLine, nextColumn] = keys[i];
            const order =
                group - nextGroup ||
                url.localeCompare(nextUrl) ||
                line - nextLine ||
                column - nextColumn;
            expect(order).toBeLessThanOrEqual(0);
        }
    });

    it.prop([runs])(
        'counts each compilation, deoptimization and decision of inlining once',
        run => {
            const total = (counted: ReadonlyArray<{ count: number }>): number =>
                counted.reduce((sum, { count }) => sum + count, 0);

            for (const fn of report(run)) {
                const compiled = run.trace.turbofan.filter(
                    compilation => compilation.function === fn.function
                );
                const considered = run.trace.turbofan.flatMap(({ candidates }) =>
                    candidates.filter(candidate => candidate.function === fn.function)
                );

                expect(total(fn.tiers)).toBe(
                    run.trace.compilations.filter(c => c.function === fn.function).length
                );
                expect(total(fn.deoptimizations)).toBe(
                    run.trace.deoptimizations.filter(d => d.function === fn.function).length
                );
                expect(total(fn.callees)).toBe(
                    compiled.reduce((sum, { candidates }) => sum + candidates.length, 0)
                );
                expect(total(fn.callers)).toBe(considered.length);
            }
        }
    );
});
