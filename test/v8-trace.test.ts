// The parsers of V8's traces and code log, on what Node and d8 wrote in the
// traced runs of the fixtures. The traced run differs between versions of
// Node, as V8's decisions do.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import {
    parseCodeLog,
    parseLoggedVersion,
    parseTrace,
    type LoggedFunction
} from '#source/node/v8-trace';
import { expectPresent } from './expectations.ts';
import {
    asOnWindows,
    escapeLog,
    fixture,
    traced,
    D8_BUNDLE_URL,
    D8_VERSION,
    REPOSITORY,
    BENCH_URL as SCRIPT,
    VERSIONS
} from './v8-fixtures.ts';

/** The logged function of a script that starts at a line and column */
function scriptFunction(
    logged: Map<string, LoggedFunction>,
    line: number,
    column: number,
    script = SCRIPT
): LoggedFunction {
    const found = Array.from(logged.values()).find(
        ({ position }) =>
            position.url === script && position.line === line && position.column === column
    );

    return expectPresent(found, `Expected a function at ${line}:${column}`);
}

describe.each(VERSIONS)('the traced run on Node %s', version => {
    const { trace, logged } = traced(version);
    const sum = scriptFunction(logged, 15, 13);
    const mix = scriptFunction(logged, 23, 13);
    const mixAll = scriptFunction(logged, 64, 16);
    const switching = scriptFunction(logged, 90, 9);

    it('reads the compilations by Maglev and Turbofan', () => {
        const tiers = trace.compilations
            .filter(compilation => compilation.function === sum.function)
            .map(({ name, tier, osr }) => [name, tier, osr]);

        expect(tiers).toStrictEqual([
            ['sum', 'MAGLEV', false],
            ['sum', 'TURBOFAN_JS', false],
            ['sum', 'MAGLEV', false],
            ['sum', 'TURBOFAN_JS', false],
            ['sum', 'MAGLEV', false],
            ['sum', 'TURBOFAN_JS', false]
        ]);
    });

    it("reads a compilation by on-stack replacement, as of the script's top level", () => {
        const topLevel = Array.from(logged.values()).find(
            fn => fn.topLevel && fn.position.url === SCRIPT
        );
        const { function: address } = expectPresent(topLevel);

        expect(
            trace.compilations.filter(compilation => compilation.function === address)
        ).toStrictEqual([{ function: address, name: '', tier: 'MAGLEV', osr: true }]);
    });

    it('reads a deoptimization, with its positions outwards from where it deoptimized', () => {
        const deoptimizations = trace.deoptimizations.filter(
            ({ function: fn }) => fn === switching.function
        );

        expect(deoptimizations).toHaveLength(1);
        expect(deoptimizations[0]).toMatchObject({
            name: 'run',
            kind: 'deopt-eager',
            reason: 'wrong map',
            positions: [
                { url: SCRIPT, line: 17, column: 29 },
                { url: SCRIPT, line: 90, column: 15 }
            ]
        });
    });

    it('reads the positions of a script without a URL, as of a timer loop, as empty', () => {
        const inLoops = trace.deoptimizations.filter(
            ({ positions }) => positions.at(-1)?.url === ''
        );

        expect(inLoops.length).toBeGreaterThan(0);
        for (const { name, tier, positions } of inLoops) {
            expect(name).toBe('');
            expect(tier).toBe('MAGLEV');
            expect(positions[0].url).toBe(SCRIPT);
        }
    });

    it("reads why Turbofan didn't inline a function, which V8 13.6 numbers", () => {
        const compilations = trace.turbofan.filter(({ function: fn }) => fn === mixAll.function);

        expect(compilations.length).toBeGreaterThan(0);
        for (const { name, osr, candidates } of compilations) {
            expect([name, osr]).toStrictEqual(['mixAll', false]);
            expect(candidates).toStrictEqual([
                {
                    function: mix.function,
                    name: 'mix',
                    bytecodeSize: undefined,
                    inlined: false,
                    reason: 'exceeds bytecode limit'
                }
            ]);
        }
    });

    it('reads the functions that Turbofan inlined, with the sizes of their bytecode', () => {
        const inlined = trace.turbofan.flatMap(({ candidates }) =>
            candidates.filter(candidate => candidate.function === sum.function)
        );

        expect(inlined.length).toBeGreaterThan(0);
        for (const candidate of inlined) {
            expect(candidate).toStrictEqual({
                function: sum.function,
                name: 'sum',
                bytecodeSize: sum.bytecodeSize,
                inlined: true,
                reason: undefined
            });
        }
    });

    it('names a function by the address that the code log names it by', () => {
        const named = [
            ...trace.compilations,
            ...trace.deoptimizations,
            ...trace.turbofan,
            ...trace.turbofan.flatMap(({ candidates }) => candidates)
        ];

        for (const { function: address, name } of named) {
            const { name: loggedName, topLevel } = expectPresent(logged.get(address), name);
            expect(topLevel ? '' : loggedName).toBe(name);
        }
    });

    it("reads a function's name, position and size of bytecode from the code log", () => {
        const { name, topLevel, position, bytecodeSize } = sum;

        expect({ name, topLevel, position }).toStrictEqual({
            name: 'sum',
            topLevel: false,
            position: { url: SCRIPT, line: 15, column: 13 }
        });
        // Its bytecode is a byte longer in V8 14.6 than in 13.6 and 15.6
        expect(bytecodeSize).toBe(version.startsWith('26.') ? 38 : 37);
    });

    it('reads a name with a comma and a letter beyond ASCII, which the log has as it is', () => {
        expect(scriptFunction(logged, 73, 12)).toMatchObject({ name: 'mean, μ', bytecodeSize: 16 });
    });

    it('reads a function compiled from a string, as a timer loop, without a URL', () => {
        const loops = Array.from(logged.values()).filter(({ position }) => position.url === '');

        expect(loops.length).toBeGreaterThan(0);
        for (const { name, position, bytecodeSize } of loops) {
            expect(name).toBe('');
            expect([position.line, position.column]).toStrictEqual([1, 20]);
            expect(bytecodeSize).toBeGreaterThan(0);
        }
    });

    it("reads a function of Node's snapshot without the size of its bytecode", () => {
        const separator = Array.from(logged.values()).find(
            ({ name }) => name === 'isPosixPathSeparator'
        );

        expect(separator).toMatchObject({
            topLevel: false,
            position: { url: 'node:path', line: 69, column: 30 },
            bytecodeSize: undefined
        });
    });

    // The script's own output comes between V8's lines on stdout
    const lines = fixture(version, 'trace.txt').split('\n');
    const insertions = fc.array(fc.tuple(fc.nat(), fc.string({ unit: 'binary' })), {
        maxLength: 30
    });

    it.prop([insertions])("skips lines that aren't V8's traces, wherever they are", inserted => {
        const mixed = lines.slice();
        for (const [at, text] of inserted) {
            mixed.splice(at % (mixed.length + 1), 0, text.replaceAll('\n', ' '));
        }

        expect(parseTrace(mixed.join('\n'))).toStrictEqual(trace);
    });
});

describe(`the traced run in d8 ${D8_VERSION}`, () => {
    // Of the bundle of the benchmark, at its positions in the bundle
    const { trace, logged } = traced(D8_VERSION, 'd8');
    const sum = scriptFunction(logged, 828, 13, D8_BUNDLE_URL);
    const mix = scriptFunction(logged, 833, 13, D8_BUNDLE_URL);
    const mixAll = scriptFunction(logged, 873, 16, D8_BUNDLE_URL);
    const switching = scriptFunction(logged, 893, 9, D8_BUNDLE_URL);

    it("names the bundle by its file's URL, which d8 names by its path", () => {
        const { name, topLevel, position, bytecodeSize } = sum;
        const paths = Array.from(logged.values()).filter(fn => fn.position.url.startsWith('/'));

        expect({ name, topLevel, position, bytecodeSize }).toStrictEqual({
            name: 'sum',
            topLevel: false,
            position: { url: D8_BUNDLE_URL, line: 828, column: 13 },
            bytecodeSize: 37
        });
        expect(paths).toStrictEqual([]);
    });

    it('reads the compilations by Maglev and Turbofan, and by on-stack replacement', () => {
        const tiers = trace.compilations
            .filter(compilation => compilation.function === sum.function)
            .map(({ tier }) => tier);
        const topLevel = Array.from(logged.values()).find(
            fn => fn.topLevel && fn.position.url === D8_BUNDLE_URL
        );
        const { function: address } = expectPresent(topLevel);

        expect(tiers).toStrictEqual([
            'MAGLEV',
            'TURBOFAN_JS',
            'MAGLEV',
            'TURBOFAN_JS',
            'MAGLEV',
            'TURBOFAN_JS'
        ]);
        expect(
            trace.compilations.filter(compilation => compilation.function === address)
        ).toStrictEqual([{ function: address, name: '', tier: 'MAGLEV', osr: true }]);
    });

    it("reads a deoptimization's positions, in the bundle and in a timer loop", () => {
        const deoptimizations = trace.deoptimizations.filter(
            ({ function: fn }) => fn === switching.function
        );
        const inLoops = trace.deoptimizations.filter(
            ({ positions }) => positions.at(-1)?.url === ''
        );

        expect(deoptimizations).toStrictEqual([
            {
                function: switching.function,
                name: 'run',
                tier: 'TURBOFAN_JS',
                kind: 'deopt-eager',
                reason: 'wrong map',
                positions: [
                    { url: D8_BUNDLE_URL, line: 830, column: 29 },
                    { url: D8_BUNDLE_URL, line: 893, column: 15 }
                ]
            }
        ]);
        expect(inLoops.length).toBeGreaterThan(0);
    });

    it("reads what Turbofan inlined, and why it didn't", () => {
        const candidates = trace.turbofan.flatMap(compilation =>
            compilation.candidates.map(candidate => [compilation.name, candidate])
        );

        expect(candidates).toStrictEqual([
            [
                'mixAll',
                {
                    function: mix.function,
                    name: 'mix',
                    bytecodeSize: undefined,
                    inlined: false,
                    reason: 'exceeds bytecode limit'
                }
            ],
            [
                'run',
                {
                    function: sum.function,
                    name: 'sum',
                    bytecodeSize: 37,
                    inlined: true,
                    reason: undefined
                }
            ],
            [
                'mixAll',
                {
                    function: mix.function,
                    name: 'mix',
                    bytecodeSize: undefined,
                    inlined: false,
                    reason: 'exceeds bytecode limit'
                }
            ],
            [
                'run',
                {
                    function: sum.function,
                    name: 'sum',
                    bytecodeSize: 37,
                    inlined: true,
                    reason: undefined
                }
            ]
        ]);
        expect(trace.turbofan.filter(({ function: fn }) => fn === mixAll.function)).toHaveLength(2);
    });

    it('names each function by the address that the code log names it by', () => {
        const named = [
            ...trace.compilations,
            ...trace.deoptimizations,
            ...trace.turbofan,
            ...trace.turbofan.flatMap(({ candidates }) => candidates)
        ];

        for (const { function: address, name } of named) {
            const { name: loggedName, topLevel } = expectPresent(logged.get(address), name);
            expect(topLevel ? '' : loggedName).toBe(name);
        }
        expect(scriptFunction(logged, 878, 33, D8_BUNDLE_URL).name).toBe('mean, μ');
    });

    it('reads the same traces as Windows would print them', () => {
        const text = fixture(D8_VERSION, 'trace.txt', 'd8');

        expect(parseTrace(asOnWindows(text))).toStrictEqual(trace);
    });
});

describe('parseLoggedVersion', () => {
    it("reads V8's version from the code log, with Node's embedder's string", () => {
        const versions = [
            ...VERSIONS.map(version => fixture(version, 'code.log')),
            fixture(D8_VERSION, 'code.log', 'd8')
        ];

        expect(versions.map(parseLoggedVersion)).toStrictEqual([
            '13.6.233.17-node.63',
            '14.6.202.34-node.40',
            '15.6.75.25-node.10',
            D8_VERSION
        ]);
    });

    it('reads none from a log without it', () => {
        expect(
            parseLoggedVersion('code-creation,Builtin,2,7542,0x1053f5e40,1112,ArrayPrototypePush')
        ).toBeUndefined();
    });
});

describe.each(VERSIONS)('the traced run on Node %s, as Windows prints it', version => {
    it('reads the same traces', () => {
        const trace = fixture(version, 'trace.txt');
        const windows = asOnWindows(trace);

        expect(windows).toContain('(sfi = 0000');
        expect(parseTrace(windows)).toStrictEqual(parseTrace(trace));
    });

    it('reads the same code log, whose lines can end in \\r\\n', () => {
        const log = fixture(version, 'code.log');

        expect(parseCodeLog(log.replaceAll('\n', '\r\n'))).toStrictEqual(parseCodeLog(log));
    });
});

describe('parseCodeLog', () => {
    it("unescapes a script's URL", () => {
        // Of Node 26.13.0, for a script in a directory named `a,b ü`
        const log =
            'code-creation,JS,10,30309,0x177eab538848,38,outer file:///project/a\\x2Cb%20%C3%BC/x.mjs:2:15,0x2729920fc1e8,~';

        expect(parseCodeLog(log).get('0x2729920fc1e8')?.position.url).toBe(
            'file:///project/a,b%20%C3%BC/x.mjs'
        );
    });

    // A directory's name with what a path can have, and the log escapes
    const directory = fc
        .stringMatching(/^[\w ,.ü-]{1,12}$/)
        .filter(name => name.trim() !== '' && !/^\.+$/.test(name.trim()));
    // A name without a space before a `/`, which would read as a path
    const name = fc.string({ maxLength: 12 }).filter(text => !/[\n\r]| \//.test(text));

    it.prop([directory, name])(
        "reads a script that d8 names by its path, which can have spaces, as its file's URL",
        (folder, functionName) => {
            const path = join(REPOSITORY, folder, 'bench.mjs');
            const log = `code-creation,JS,10,15097,0x2173010411ac,38,${functionName} ${escapeLog(path)}:2:15,0x217301022880,~`;
            const trace = `[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing 0x1 <JSFunction run (sfi = 0x217301022881)>, 0x3 <Code MAGLEV>, opt id 2]\n            ;;; deoptimize at <${path}:3:4> inlined at <unknown:6:22>`;
            const url = pathToFileURL(path).href;

            expect(parseCodeLog(log).get('0x217301022880')).toStrictEqual({
                function: '0x217301022880',
                name: functionName,
                topLevel: false,
                position: { url, line: 2, column: 15 },
                bytecodeSize: 38
            });
            expect(parseTrace(trace).deoptimizations[0].positions).toStrictEqual([
                { url, line: 3, column: 4 },
                { url: '', line: 6, column: 22 }
            ]);
        }
    );

    it('skips lines of other events, and code without a position', () => {
        const log = [
            'v8-version,14,6,202,34,-node.40,0',
            'code-creation,Builtin,2,7542,0x1053f5e40,1112,ArrayPrototypePush',
            'code-creation,JS,5,185981,0x2c8417802e40,192,__wbindgen_add_to_stack_pointer,0x10d76cb3a,',
            "script-source,6,node:internal/bootstrap/realm,'use strict';\\n"
        ].join('\n');

        expect(parseCodeLog(log)).toStrictEqual(new Map());
    });
});
