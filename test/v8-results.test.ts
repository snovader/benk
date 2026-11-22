// V8's report as the results have it: the traced run's markers, what the
// traces tie to each variant, Turbofan's limits, and the check of
// `--v8-check`, on the fixtures' traced runs of `fixtures/v8/bench.ts`
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import {
    measureGroups,
    type GroupResult,
    type V8VariantDeoptimization,
    type VariantV8
} from 'benk';
import { functionPositions } from '#source/node/function-positions';
import { readTracedOutput, type TracedGroup } from '#source/node/traced-markers';
import { checkFunctions } from '#source/node/v8-check';
import { parseInliningLimits, readInliningLimits } from '#source/node/v8-limits';
import {
    formatCheck,
    formatLimits,
    formatVariants,
    isScriptUrl,
    reportFunctions
} from '#source/node/v8-report';
import { variantsV8 } from '#source/node/v8-results';
import { parseTrace, type SourcePosition, type V8Trace } from '#source/node/v8-trace';
import { expectPresent } from './expectations.ts';
import { FakeRuntime } from './fake-runtime.ts';
import { fixture, traced, BENCH, BENCH_URL, REPOSITORY, VERSIONS } from './v8-fixtures.ts';

/** benk's directory in the fixtures, as `capture.ts` loaded it from its source */
const BENK_SOURCE = `${pathToFileURL(join(REPOSITORY, 'source')).href}/`;

const isScript = (url: string): boolean => isScriptUrl(url, BENK_SOURCE);

/** V8's defaults in Node 26, as `node --v8-options` printed them */
const LIMITS = {
    maxInlinedBytecodeSize: 460,
    maxInlinedBytecodeSizeCumulative: 920,
    maxInlinedBytecodeSizeSmall: 30
};

/** Where V8 placed the `run` of each variant of `bench.ts`, as the traced run read it */
const RUNS: Readonly<Record<string, readonly [line: number, column: number]>> = {
    integers: [80, 9],
    mean: [84, 9],
    switching: [90, 9],
    mixed: [94, 9]
};

/** The results of a run of `bench.ts`'s group, with its names, from a fake runtime */
async function benchResults(): Promise<readonly GroupResult[]> {
    const runtime = new FakeRuntime();
    const { groups } = await measureGroups(
        [{ name: 'sums', variants: Object.keys(RUNS).map(name => runtime.variant(name, 10)) }],
        { sampleTime: 0.01, warmupRounds: 0, rounds: 1, heap: false, runtime }
    );

    return groups;
}

const results = await benchResults();

/** Where the traced run placed the `run` of a variant of `bench.ts` */
function runOf(name: string): SourcePosition {
    const [line, column] = RUNS[name === 'integers A/A' ? 'integers' : name];

    return { url: BENCH_URL, line, column };
}

/**
 * The groups of the results as the traced run would mark them, by their
 * names, or by another, with each variant's run where `run` places it
 */
function tracedGroups({
    name,
    run = runOf
}: {
    name?: string;
    run?: (variant: string, i: number) => SourcePosition | null;
} = {}): TracedGroup[] {
    return results.map(group => ({
        name: name ?? group.name,
        variants: group.variants.map((variant, i) => ({
            name: variant.name,
            role: variant.role,
            run: run(variant.name, i)
        }))
    }));
}

/** What V8 did with each variant of `bench.ts`, by its name, in a version's traced run */
function variantsOf(
    version: string,
    groups: readonly TracedGroup[] = tracedGroups()
): Map<string, VariantV8 | null> {
    const { trace, logged } = traced(version);
    const [variants] = variantsV8(results, { trace, timed: [], groups }, logged, undefined);

    return new Map(results[0].variants.map(({ name }, i) => [name, variants[i]]));
}

describe('variantsV8', () => {
    // The loops of each variant that the traces tie to its run: by Turbofan's
    // compilations, in Node 24, and by Maglev's deoptimizations in each
    const LOOPS: Readonly<Record<string, Record<string, number>>> = {
        '24.22.3': { integers: 2, mean: 1, switching: 1, mixed: 0, 'integers A/A': 2 },
        '26.13.0': { integers: 2, mean: 1, switching: 0, mixed: 0, 'integers A/A': 2 },
        '27.0.0-alpha.0.0.0': { integers: 2, mean: 1, switching: 0, mixed: 1, 'integers A/A': 2 }
    };

    it.each(VERSIONS)('ties the timer loops to the variants of their runs on Node %s', version => {
        const variants = variantsOf(version);
        const loops = Object.fromEntries(
            Array.from(variants, ([name, v8]) => [name, expectPresent(v8).loops])
        );

        expect(loops).toStrictEqual(LOOPS[version]);
    });

    it.each(VERSIONS)("names each variant's run, and those that share it, on Node %s", version => {
        const variants = variantsOf(version);

        for (const [name, v8] of variants) {
            const [line, column] = RUNS[name === 'integers A/A' ? 'integers' : name];
            const { run } = expectPresent(v8);
            expect(run?.name).toBe('run');
            expect(run?.position).toStrictEqual({ url: BENCH_URL, line, column });
        }
        expect(variants.get('integers')?.sharedWith).toStrictEqual([
            { group: 'sums', variant: 'integers A/A' }
        ]);
        expect(variants.get('integers A/A')?.sharedWith).toStrictEqual([
            { group: 'sums', variant: 'integers' }
        ]);
        expect(variants.get('mean')?.sharedWith).toStrictEqual([]);
    });

    it('writes what Turbofan inlined into the loops of a variant, and their deoptimizations', () => {
        const mean = expectPresent(variantsOf('24.22.3').get('mean'));

        expect(mean.inlining.map(({ function: fn, inlined }) => [fn.name, inlined])).toStrictEqual([
            ['now', true],
            ['run', true],
            ['mean, μ', true],
            ['sum', true],
            ['wrappedFn', true],
            ['', true]
        ]);
        expect(
            mean.deoptimizations.map(({ code, reason, positions }) => [
                code,
                reason,
                positions.map(({ line, column }) => `${line}:${column}`).join(' ')
            ])
        ).toStrictEqual([
            ['loop', 'wrong map', '73:45 84:36 5:9'],
            ['run', 'wrong map', '17:29 73:24 84:36']
        ]);
    });

    it.prop([
        fc.array(fc.constantFrom(...Object.keys(RUNS), undefined), { minLength: 5, maxLength: 5 })
    ])('gives the variants with the same run the same loops, and each the others', assigned => {
        // The runs of the five variants, each one of bench.ts's, or none
        const groups = tracedGroups({
            run: (_, i) => {
                const run = assigned[i];
                return run == null ? null : runOf(run);
            }
        });
        const variants = Array.from(variantsOf('26.13.0', groups).values(), v8 =>
            expectPresent(v8)
        );

        for (const [i, v8] of variants.entries()) {
            const same = variants
                .map((other, j) => [other, j] as const)
                .filter(([, j]) => j !== i && assigned[i] != null && assigned[j] === assigned[i]);

            expect(v8.sharedWith.map(({ variant }) => variant)).toStrictEqual(
                same.map(([, j]) => results[0].variants[j].name)
            );
            for (const [other] of same) {
                expect(other.loops).toBe(v8.loops);
                expect(other.loopTiers).toStrictEqual(v8.loopTiers);
            }
            if (assigned[i] == null) {
                expect(v8.run).toBeNull();
                expect(v8.loops).toBe(0);
            }
        }
    });

    it('has nothing of a group that the traced run measured under another name', () => {
        const groups = tracedGroups({ name: 'other' });

        expect(Array.from(variantsOf('26.13.0', groups).values())).toStrictEqual([
            null,
            null,
            null,
            null,
            null
        ]);
    });

    it('writes the lines of each variant beside its name in the table', () => {
        const variants = variantsOf('26.13.0');
        const group: GroupResult = {
            ...results[0],
            variants: results[0].variants.map(variant =>
                Object.assign({}, variant, { v8: variants.get(variant.name) ?? null })
            )
        };

        const lines = formatVariants([group], { directory: REPOSITORY, isScript });
        const integers = lines.indexOf(
            `  integers: run ${BENCH}:80:9, 13 B of bytecode, compiled to Maglev ×2`
        );

        expect(lines[2]).toBe('sums');
        expect(lines.slice(integers, integers + 4)).toStrictEqual([
            `  integers: run ${BENCH}:80:9, 13 B of bytecode, compiled to Maglev ×2`,
            '    2 timer loops, also of integers A/A, compiled to Maglev ×4',
            `    loop deoptimized in Maglev's code: wrong map (eager), at ${BENCH}:17:29, inlined at ${BENCH}:80:15, inlined at <anonymous>:6:22 ×2`,
            `    run deoptimized in Maglev's code: wrong map (eager), at ${BENCH}:17:29, inlined at ${BENCH}:80:15`
        ]);
        expect(lines).toContain('    no timer loop that the traces tie to its run');
    });
});

describe('readTracedOutput', () => {
    const output = fixture('26.13.0', 'trace.txt');
    const lines = output.split('\n');
    // Where a marker can be: before a compilation or a deoptimization starts,
    // as V8 writes neither while JavaScript writes a marker
    const between = lines.flatMap((line, i) =>
        line.startsWith('[compiling method') || line.startsWith('[bailout (') ? [i] : []
    );
    const cuts = fc
        .uniqueArray(fc.constantFrom(...between), { minLength: 4, maxLength: 4 })
        .map(chosen => chosen.toSorted((a, b) => a - b));

    const marker = (json: object): string => `benk-traced-run ${JSON.stringify(json)}`;

    it.prop([cuts])(
        "places V8's lines between markers, without changing what they say",
        ([start, timed, done, end]) => {
            const marked = [
                ...lines.slice(0, start),
                marker({ bench: 0, event: 'start' }),
                ...lines.slice(start, timed),
                marker({ bench: 0, event: 'timed', group: 0 }),
                ...lines.slice(timed, done),
                marker({ bench: 0, event: 'done', group: 0 }),
                ...lines.slice(done, end),
                marker({ bench: 0, event: 'end' }),
                marker({ bench: 0, event: 'variants', groups: [] }),
                ...lines.slice(end)
            ].join('\n');

            const read = readTracedOutput(marked, true);
            const bench = expectPresent(read.benches.get(0));

            expect(read.trace).toStrictEqual(parseTrace(output));
            expect(bench.trace).toStrictEqual(parseTrace(lines.slice(start, end).join('\n')));
            expect(bench.timed).toStrictEqual([parseTrace(lines.slice(timed, done).join('\n'))]);
            expect(bench.groups).toStrictEqual([]);
        }
    );

    // As Node writes V8's traces on Windows: in chunks of the C runtime's
    // buffer, of 4,096 bytes, among which a marker falls, within a line
    const chunked = fc
        .uniqueArray(fc.integer({ min: 1, max: output.length - 1 }), {
            minLength: 5,
            maxLength: 5
        })
        .map(chosen => chosen.toSorted((a, b) => a - b));

    it.prop([chunked, fc.boolean()])(
        "cuts out markers that fall within V8's lines, and doesn't place the traces by them",
        (at, inOrder) => {
            const events = [
                marker({ bench: 0, event: 'start' }),
                marker({ bench: 0, event: 'timed', group: 0 }),
                marker({ bench: 0, event: 'done', group: 0 }),
                marker({ bench: 0, event: 'end' }),
                marker({ bench: 0, event: 'variants', groups: tracedGroups() })
            ];
            const marked = events
                .map((event, i) => `${output.slice(at[i - 1] ?? 0, at[i])}${event}\n`)
                .join('');
            const read = readTracedOutput(`${marked}${output.slice(at[4])}`, inOrder);
            const bench = expectPresent(read.benches.get(0));

            expect(read.trace).toStrictEqual(parseTrace(output));
            expect(bench.trace).toStrictEqual(read.trace);
            expect(bench.groups).toStrictEqual(tracedGroups());
            // Unless each marker started a line, which shows nothing
            if (!inOrder || at.some(i => output[i - 1] !== '\n')) {
                expect(bench.timed).toBeUndefined();
            }
        }
    );

    it.each([
        ['all of', 0, lines.length],
        ['none of', 0, 0]
    ])("counts a variant's deoptimizations in %s the timed rounds", (_, timed, done) => {
        const { logged } = traced('26.13.0');
        const marked = [
            marker({ bench: 0, event: 'start' }),
            ...lines.slice(0, timed),
            marker({ bench: 0, event: 'timed', group: 0 }),
            ...lines.slice(timed, done),
            marker({ bench: 0, event: 'done', group: 0 }),
            ...lines.slice(done),
            marker({ bench: 0, event: 'end' }),
            marker({ bench: 0, event: 'variants', groups: tracedGroups() })
        ].join('\n');
        const deoptimizationsOf = (inOrder: boolean): V8VariantDeoptimization[] => {
            const bench = expectPresent(readTracedOutput(marked, inOrder).benches.get(0));
            const [variants] = variantsV8(results, bench, logged, undefined);

            return variants.flatMap(v8 => expectPresent(v8).deoptimizations);
        };

        const deoptimizations = deoptimizationsOf(true);
        expect(deoptimizations.length).toBeGreaterThan(0);
        for (const { count, timed: inTimedRounds } of deoptimizations) {
            expect(inTimedRounds).toBe(done === 0 ? 0 : count);
        }
        // Where the markers aren't in order, as on Windows, the traces can't say
        expect(
            deoptimizationsOf(false).map(({ timed: inTimedRounds }) => inTimedRounds)
        ).toStrictEqual(deoptimizations.map(() => null));
    });

    it('reads a line that only starts as a marker as one of the script', () => {
        const read = readTracedOutput(`benk-traced-run {not JSON\n${output}`, true);

        expect(read.trace).toStrictEqual(parseTrace(output));
        expect(read.benches.size).toBe(0);
    });
});

describe('checkFunctions', () => {
    const listed = (
        version: string,
        filter?: RegExp
    ): { trace: V8Trace; reports: ReturnType<typeof reportFunctions> } => {
        const { trace, logged } = traced(version);
        return {
            trace,
            reports: reportFunctions(trace, logged, { benkDirectory: BENK_SOURCE, filter })
        };
    };

    it.each(VERSIONS)(
        "fails a function over Turbofan's limit that it considered inlining, on Node %s",
        version => {
            const { reports } = listed(version);

            const check = checkFunctions(reports, [], {
                limits: LIMITS,
                maxBytecodeSize: undefined,
                isScript
            });
            const [failure] = check.failures;

            expect(check.passed).toBe(false);
            expect(check.failures).toHaveLength(1);
            expect(failure.kind).toBe('over budget');
            expect(failure.function.name).toBe('mix');
            expect(failure.function.bytecodeSize).toBe(874);
            expect(
                failure.kind === 'over budget' && failure.consideredFor.map(fn => fn.name)
            ).toStrictEqual(['mixAll']);
        }
    );

    it('passes where V8 allows more bytecode, and nothing deoptimized in timed rounds', () => {
        const { reports } = listed('26.13.0');
        const limits = { ...LIMITS, maxInlinedBytecodeSize: 1000 };

        expect(
            checkFunctions(reports, [], { limits, maxBytecodeSize: undefined, isScript })
        ).toStrictEqual({
            passed: true,
            deoptimizationsChecked: true,
            maxBytecodeSize: null,
            failures: []
        });
    });

    it("says that it didn't check for deoptimizations without the timed rounds' traces", () => {
        const { reports } = listed('26.13.0');
        const check = checkFunctions(reports, undefined, {
            limits: LIMITS,
            maxBytecodeSize: undefined,
            isScript
        });

        expect(check.deoptimizationsChecked).toBe(false);
        expect(check.failures.map(failure => failure.kind)).toStrictEqual(['over budget']);
        expect(formatCheck({ ...check, passed: true, failures: [] }, REPOSITORY)).toStrictEqual([
            '',
            "V8 check passed: no hot function of the report is over Turbofan's limit.",
            "  Deoptimizations weren't checked: V8's traces reached stdout in chunks of the C runtime's buffer, as Node buffers it on Windows, so the timed rounds can't be placed among them."
        ]);
    });

    it.prop([fc.constantFrom(...VERSIONS), fc.integer({ min: 1, max: 1000 })])(
        "fails each hot function of the script over the user's limit, and no other",
        (version, limit) => {
            const { reports } = listed(version);
            const check = checkFunctions(reports, [], {
                limits: { ...LIMITS, maxInlinedBytecodeSize: 1000 },
                maxBytecodeSize: limit,
                isScript
            });

            const hot = reports.filter(
                ({ position, topLevel, bytecodeSize, tiers, callers }) =>
                    position != null &&
                    isScript(position.url) &&
                    !topLevel &&
                    bytecodeSize != null &&
                    bytecodeSize > limit &&
                    (callers.length > 0 || tiers.some(({ value }) => value.tier === 'TURBOFAN_JS'))
            );
            expect(check.failures.map(failure => failure.kind)).toStrictEqual(
                hot.map(() => 'over limit')
            );
            expect(check.failures.map(failure => failure.function.position)).toStrictEqual(
                hot.map(({ position }) => position)
            );
            expect(check.maxBytecodeSize).toBe(limit);
        }
    );

    it.prop([fc.constantFrom(...VERSIONS), fc.infiniteStream(fc.boolean())])(
        "fails each deoptimization of a listed function in a group's timed rounds",
        (version, chosen) => {
            const { trace, reports } = listed(version);
            const timed: V8Trace = {
                ...trace,
                deoptimizations: trace.deoptimizations.filter(() => chosen.next().value)
            };
            const listedAddresses = new Set(reports.map(report => report.function));

            const check = checkFunctions(reports, [{ name: 'sums', trace: timed }], {
                limits: { ...LIMITS, maxInlinedBytecodeSize: 1000 },
                maxBytecodeSize: undefined,
                isScript
            });

            const failed = check.failures.reduce(
                (sum, failure) => sum + (failure.kind === 'deoptimized' ? failure.count : 0),
                0
            );
            expect(failed).toBe(
                timed.deoptimizations.filter(d => listedAddresses.has(d.function)).length
            );
            expect(check.passed).toBe(failed === 0);
        }
    );

    it('checks only the functions that the filter lists', () => {
        const { reports } = listed('26.13.0', /^sum$/u);

        expect(
            checkFunctions(reports, [], {
                limits: LIMITS,
                maxBytecodeSize: 1,
                isScript
            }).failures.map(failure => [failure.kind, failure.function.name])
        ).toStrictEqual([['over limit', 'sum']]);
    });

    it('writes each failure, those alike once with their count', () => {
        const { trace, reports } = listed('26.13.0');
        const twice: V8Trace = {
            ...trace,
            deoptimizations: trace.deoptimizations.filter(({ name }) => name === 'mix')
        };
        const check = checkFunctions(
            reports,
            [
                { name: 'sums', trace: twice },
                { name: 'sums', trace: twice }
            ],
            {
                limits: LIMITS,
                maxBytecodeSize: undefined,
                isScript
            }
        );

        expect(formatCheck(check, REPOSITORY)).toStrictEqual([
            '',
            'V8 check failed:',
            `  mix ${BENCH}:23:13, 874 B of bytecode, over Turbofan's 460 B, and considered for inlining into mixAll ${BENCH}:64:16`,
            `  mix ${BENCH}:23:13 deoptimized in Turbofan's code: not a Smi (eager), at ${BENCH}:24:15, in the timed rounds of sums ×2`
        ]);
        expect(
            formatCheck(
                { passed: true, deoptimizationsChecked: true, maxBytecodeSize: 400, failures: [] },
                REPOSITORY
            )
        ).toStrictEqual([
            '',
            "V8 check passed: no hot function of the report is over Turbofan's limit or 400 B, and none deoptimized in the timed rounds."
        ]);
    });
});

describe('Turbofan limits', () => {
    it('reads the limits that the flags set, as V8 prints them', async () => {
        const limits = expectPresent(await readInliningLimits(['--max-inlined-bytecode-size=600']));

        expect(limits.maxInlinedBytecodeSize).toBe(600);
        expect(limits.maxInlinedBytecodeSizeCumulative).toBeGreaterThan(0);
        expect(limits.maxInlinedBytecodeSizeSmall).toBeGreaterThan(0);
    });

    it("has none where V8 doesn't print one of the flags", () => {
        const help = [
            '        type: int  default: --max-inlined-bytecode-size=460',
            '        type: int  default: --max-inlined-bytecode-size-small=30'
        ].join('\n');

        expect(parseInliningLimits(help)).toBeNull();
        expect(
            parseInliningLimits(
                `${help}\r\n        type: int  default: --max-inlined-bytecode-size-cumulative=920\r\n`
            )
        ).toStrictEqual(LIMITS);
    });

    it('writes them in a line', () => {
        expect(formatLimits(LIMITS)).toBe(
            "Turbofan's limits, from V8's flags: 460 B of bytecode for a function that it inlines, 920 B for the functions that one compilation inlines, in all, and 30 B for a small function, which it inlines beyond that."
        );
        expect(formatLimits(null)).toBe("Turbofan's limits: node --v8-options didn't print them.");
    });
});

describe('functionPositions', () => {
    it('reads where a function starts, and a bound function its target, but not a builtin', async () => {
        // A script of a known source and URL, whose body starts on its third line
        // oxlint-disable-next-line typescript/no-implied-eval -- Compiles the functions whose positions are read
        const functions = new Function(
            'return [() => 1, { run(a) { return a; } }.run];\n//# sourceURL=positions.js'
        ) as () => Array<() => unknown>;
        const [arrow, method] = functions();

        expect(
            await functionPositions([arrow, method, arrow.bind(null), Math.random])
        ).toStrictEqual([
            { url: 'positions.js', line: 3, column: 9 },
            { url: 'positions.js', line: 3, column: 23 },
            { url: 'positions.js', line: 3, column: 9 },
            null
        ]);
    });
});
