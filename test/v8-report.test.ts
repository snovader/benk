// The V8 report: which functions it lists, and how it writes them, on the
// fixtures' traced runs and on traces made up to cover what they don't
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { readSourceMaps, SourceMaps } from '#source/node/source-maps';
import {
    formatV8Report,
    reportFunctions,
    tracedScripts,
    type FunctionReport
} from '#source/node/v8-report';
import {
    parseCodeLog,
    parseTrace,
    type Compilation,
    type Deoptimization,
    type LoggedFunction,
    type SourcePosition,
    type TurbofanCompilation,
    type V8Trace
} from '#source/node/v8-trace';
import {
    asOnWindows,
    fixture,
    traced,
    BENCH,
    BUNDLE,
    BUNDLE_URL,
    BUNDLED,
    BUNDLED_VERSION,
    D8_BUNDLE,
    D8_VERSION,
    REPOSITORY,
    VERSIONS
} from './v8-fixtures.ts';

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

describe('the report of the bundled traced run', () => {
    const { trace, logged } = traced(BUNDLED_VERSION, 'bundle');
    const format = { script: join(REPOSITORY, BUNDLE), directory: REPOSITORY };
    const SUM = join(BUNDLED, 'sum.ts');
    const SOURCE = join(BUNDLED, 'bench.ts');

    async function lines(options: { filter?: RegExp } = {}): Promise<string[]> {
        const sourceMaps = await readSourceMaps(tracedScripts(trace, logged));
        const reports = reportFunctions(trace, logged, {
            benkDirectory: BENK_SOURCE,
            sourceMaps,
            ...options
        });

        return formatV8Report(reports, { ...format, sourceMaps, ...options });
    }

    it('places functions and deoptimizations in the sources that its source map names', async () => {
        const report = await lines();

        expect(linesOf(report, `sum ${SUM}:6:20, 38 B of bytecode`)).toStrictEqual([
            `sum ${SUM}:6:20, 38 B of bytecode`,
            '  compiled to Maglev ×3, Turbofan ×3',
            `  inlined into run ${SOURCE}:26:22 ×2`,
            `  deoptimized in Turbofan's code: wrong map (eager), at ${SUM}:8:32 ×2`
        ]);
        // `sum` inlined into `mean`, inlined into a variant's `run`
        expect(linesOf(report, `run ${SOURCE}:21:34, 13 B of bytecode`)).toStrictEqual([
            `run ${SOURCE}:21:34, 13 B of bytecode`,
            '  compiled to Maglev ×2',
            `  deoptimized in Maglev's code: wrong map (eager), at ${SUM}:8:32, inlined at ${SUM}:17:12, inlined at ${SOURCE}:21:40`
        ]);
        expect(report.filter(line => line.includes('bench.mjs'))).toStrictEqual([report[1]]);
    });

    it('lists the functions of the sources by their positions in them', async () => {
        const named = (await lines())
            .slice(3)
            .filter(line => !line.startsWith('  ') && !line.includes('<anonymous>'))
            .map(line => line.slice(0, line.indexOf(',')));

        expect(named).toStrictEqual([
            `(anonymous) ${SOURCE}:11:47`,
            `(anonymous) ${SOURCE}:12:46`,
            `run ${SOURCE}:20:33`,
            `run ${SOURCE}:21:34`,
            `run ${SOURCE}:26:22`,
            `sum ${SUM}:6:20`
        ]);
    });

    it("writes the bundle's own positions without its source map", () => {
        const reports = reportFunctions(trace, logged, { benkDirectory: BENK_SOURCE });

        expect(formatV8Report(reports, format)[3]).toBe(`sum ${BUNDLE}:4:13, 38 B of bytecode`);
    });

    it("says why a script's positions are its own, if it places one in a script whose source map couldn't be read", () => {
        const unread = new Map([
            [BUNDLE_URL, "its source map, bench.mjs.map, couldn't be read (ENOENT)"],
            ['file:///project/node_modules/library/index.js', "it couldn't be read (EACCES)"]
        ]);
        const sourceMaps = new SourceMaps(new Map(), unread);
        const reports = reportFunctions(trace, logged, { benkDirectory: BENK_SOURCE, sourceMaps });

        expect(formatV8Report(reports, { ...format, sourceMaps }).slice(0, 5)).toStrictEqual([
            '',
            `V8 report of ${BUNDLE}, from a run of it with V8's traces, whose times aren't reported.`,
            "Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.",
            `Positions in ${BUNDLE} are its own: its source map, bench.mjs.map, couldn't be read (ENOENT).`,
            `sum ${BUNDLE}:4:13, 38 B of bytecode`
        ]);
    });

    it('lists only the functions whose names match the filter, and says so', async () => {
        expect(await lines({ filter: /^sum$/u })).toStrictEqual([
            '',
            `V8 report of ${BUNDLE}, from a run of it with V8's traces, whose times aren't reported.`,
            "Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.",
            'Only the functions whose names match ^sum$.',
            `sum ${SUM}:6:20, 38 B of bytecode`,
            '  compiled to Maglev ×3, Turbofan ×3',
            `  inlined into run ${SOURCE}:26:22 ×2`,
            `  deoptimized in Turbofan's code: wrong map (eager), at ${SUM}:8:32 ×2`
        ]);
        expect((await lines({ filter: /^nothing$/u })).slice(3)).toStrictEqual([
            'Only the functions whose names match ^nothing$.',
            '  No function of the script whose name matches ^nothing$ was optimized.'
        ]);
    });

    it('places the same positions of the traces as V8 prints them on Windows', async () => {
        const windows = {
            trace: parseTrace(asOnWindows(fixture(BUNDLED_VERSION, 'trace.txt', 'bundle'))),
            logged: parseCodeLog(
                fixture(BUNDLED_VERSION, 'code.log', 'bundle').replaceAll('\n', '\r\n')
            )
        };
        const sourceMaps = await readSourceMaps(tracedScripts(windows.trace, windows.logged));
        const reports = reportFunctions(windows.trace, windows.logged, {
            benkDirectory: BENK_SOURCE,
            sourceMaps
        });

        expect(formatV8Report(reports, { ...format, sourceMaps })).toStrictEqual(await lines());
    });
});

describe(`the report of the traced run in d8 ${D8_VERSION}`, () => {
    // Of the benchmark's bundle, which has benk's source in it
    const { trace, logged } = traced(D8_VERSION, 'd8');
    const format = {
        script: join(REPOSITORY, D8_BUNDLE),
        directory: REPOSITORY,
        engine: `d8 ${D8_VERSION}`
    };

    async function lines(options: { filter?: RegExp } = {}): Promise<string[]> {
        const sourceMaps = await readSourceMaps(tracedScripts(trace, logged));
        const reports = reportFunctions(trace, logged, {
            benkDirectory: BENK_SOURCE,
            sourceMaps,
            ...options
        });

        return formatV8Report(reports, { ...format, sourceMaps, ...options });
    }

    it('names d8 and its version in the heading', async () => {
        expect((await lines()).slice(0, 2)).toStrictEqual([
            '',
            `V8 report of ${D8_BUNDLE}, from a run of it in d8 ${D8_VERSION} with V8's traces, whose times aren't reported.`
        ]);
    });

    it("places the bundle's functions in the benchmark's source, and lists them first", async () => {
        const named = (await lines())
            .slice(3)
            .filter(line => !line.startsWith('  '))
            .map(line => line.replace(/, [\d,]+ B of bytecode$/, ''));

        expect(named).toStrictEqual([
            `(anonymous) ${BENCH}:9:47`,
            `(anonymous) ${BENCH}:10:46`,
            `sum ${BENCH}:19:13`,
            `mix ${BENCH}:29:13`,
            `mixAll ${BENCH}:72:16`,
            `mean, μ ${BENCH}:83:16`,
            `run ${BENCH}:92:38`,
            `run ${BENCH}:93:34`,
            `run ${BENCH}:98:22`,
            `run ${BENCH}:100:35`,
            // Its top level, before the first mapping of its line
            `(top level) ${D8_BUNDLE}:1:1`,
            // The timer loops, which deoptimized in the benchmark's code
            ...Array.from({ length: 4 }, () => '(anonymous) <anonymous>:1:20')
        ]);
    });

    it('lists only the functions whose names match the filter, with their inlining and deoptimizations', async () => {
        expect((await lines({ filter: /^(?:sum|mixAll)$/u })).slice(3)).toStrictEqual([
            'Only the functions whose names match ^(?:sum|mixAll)$.',
            `sum ${BENCH}:19:13, 37 B of bytecode`,
            '  compiled to Maglev ×3, Turbofan ×3',
            `  inlined into run ${BENCH}:98:22 ×2`,
            `  deoptimized in Turbofan's code: wrong map (eager), at ${BENCH}:21:32 ×2`,
            `mixAll ${BENCH}:72:16, 46 B of bytecode`,
            '  compiled to Maglev ×2, Turbofan ×2',
            `  doesn't inline mix ${BENCH}:29:13 (858 B): exceeds bytecode limit ×2`,
            `  deoptimized in Turbofan's code: wrong map (eager), at ${BENCH}:74:32`
        ]);
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

function report(
    {
        trace,
        logged
    }: {
        trace: V8Trace;
        logged: Map<string, LoggedFunction>;
    },
    filter?: RegExp
): FunctionReport[] {
    return reportFunctions(trace, logged, { benkDirectory: BENK, filter });
}

/** A function's name, as the report writes it */
function writtenName({ name, topLevel }: FunctionReport): string {
    return topLevel ? '(top level)' : name || '(anonymous)';
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

describe('reportFunctions with a filter', () => {
    const filters = fc.constantFrom(
        /^sum$/u,
        /run|sum/u,
        /anonymous/u,
        /^\(top level\)$/u,
        /^$/u,
        /x/u
    );

    it.prop([runs, filters])(
        'lists the functions whose names, as the report writes them, match the filter, in the same order',
        (run, filter) => {
            const listed = report(run, filter).map(fn => fn.function);
            const matching = report(run)
                .filter(fn => filter.test(writtenName(fn)))
                .map(fn => fn.function);

            expect(listed).toStrictEqual(matching);
        }
    );
});

describe('tracedScripts', () => {
    it.prop([runs])('names the script of each position that the report has', run => {
        const scripts = tracedScripts(run.trace, run.logged);

        for (const fn of report(run)) {
            const positions = [
                fn.position,
                ...[...fn.callees, ...fn.callers].map(({ value }) => value.other.position),
                ...fn.deoptimizations.flatMap(({ value }) => value.positions)
            ];
            for (const position of positions) {
                if (position != null) {
                    expect(scripts.has(position.url), position.url).toBe(true);
                }
            }
        }
    });
});
