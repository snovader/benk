// The parsers of V8's traces and code log, on what Node wrote in the traced
// runs of the fixtures. The traced run differs between versions of Node, as
// V8's decisions do.
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { parseCodeLog, parseTrace, type LoggedFunction } from '#source/node/v8-trace';
import { expectPresent } from './expectations.ts';
import { fixture, traced, BENCH_URL as SCRIPT, VERSIONS } from './v8-fixtures.ts';

/** The logged function of the script that starts at a line and column */
function scriptFunction(
    logged: Map<string, LoggedFunction>,
    line: number,
    column: number
): LoggedFunction {
    const found = Array.from(logged.values()).find(
        ({ position }) =>
            position.url === SCRIPT && position.line === line && position.column === column
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

/**
 * A fixture's traces as V8 prints them on Windows: where V8 prints an address
 * with the C library's `%p`, or as a stream's `void*`, the Microsoft runtime
 * writes 16 digits in upper case without `0x`, and lines can end in `\r\n`.
 * The addresses that V8 formats itself, padded after `0x`, stay as they are.
 */
function asOnWindows(trace: string): string {
    const pointer = (hex: string): string => hex.toUpperCase().padStart(16, '0');

    return trace
        .replaceAll(/\(sfi = 0x([\da-f]+)\)/g, (_, hex: string) => `(sfi = ${pointer(hex)})`)
        .replaceAll(/0x([\da-f]+) \{/g, (_, hex: string) => `${pointer(hex)} {`)
        .replaceAll('\n', '\r\n');
}

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
