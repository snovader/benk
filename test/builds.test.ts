// The comparison of two builds that `compareBuilds()` makes, of the modules
// in `fixtures/builds/`, whose calls the fake runtime times, so that a test
// knows each ratio: head's `sum` takes half as long as base's. The
// comparison across processes, and its formatting, are tested on results
// whose ratios and intervals a test sets.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import {
    bench,
    compareBuilds,
    type BuildComparison,
    type BuildName,
    type Group,
    type GroupAcrossProcesses,
    type GroupsOfBuild,
    type Lead,
    type RunResult,
    type Variant,
    type VariantAcrossProcesses
} from 'benk';
import { firstBuildIn, withBuilds } from '#source/core/builds';
import { formatBuilds } from '#source/core/report';
import { expectClose, expectPresent } from './expectations.ts';
import { FakeRuntime } from './fake-runtime.ts';
import { REPOSITORY } from './v8-fixtures.ts';

const BASE = join('test', 'fixtures', 'builds', 'base.ts');
const HEAD = join('test', 'fixtures', 'builds', 'head.ts');
const QUICK = ['--sample-ms', '0.01', '--warmup-rounds', '1', '--rounds', '6'];
const BUILDS = ['--base', BASE, '--head', HEAD];

/** A build's module, as the fixtures export it */
interface Build {
    readonly NAME: BuildName;
    readonly NANOSECONDS: { readonly sum: number; readonly sort: number };
}

/** The groups of a build: `sum` and `sort`, which the fake runtime times */
function groupsOf(runtime: FakeRuntime): GroupsOfBuild<Build> {
    return build => [
        {
            name: 'calls',
            variants: [
                runtime.variant('sum', build.NANOSECONDS.sum),
                runtime.variant('sort', build.NANOSECONDS.sort)
            ]
        }
    ];
}

/** Compares the fixtures' builds with the fake runtime, and the lines that it prints */
async function compare(
    args: readonly string[] = [],
    groups?: GroupsOfBuild<Build>
): Promise<{ result: RunResult; lines: string[] }> {
    const runtime = new FakeRuntime();
    const lines: string[] = [];
    const result = await compareBuilds(groups ?? groupsOf(runtime), {
        args: [...QUICK, ...BUILDS, ...args],
        runtime,
        print: line => lines.push(line)
    });

    return { result, lines };
}

describe('compareBuilds', () => {
    it("pairs each variant of the builds in a group of its own, of base, head, and base's A/A copy", async () => {
        const { result } = await compare();
        const builds = expectPresent(result.builds);

        expect(result.groups.map(group => group.name)).toStrictEqual([
            'calls / sum',
            'calls / sort'
        ]);
        for (const group of result.groups) {
            expect(group.variants.map(({ name, role }) => [name, role])).toStrictEqual([
                ['base', 'reference'],
                ['head', 'variant'],
                ['base A/A', 'aa']
            ]);
        }
        expectClose(expectPresent(result.groups[0].variants[1].ratio), 0.5);
        expectClose(expectPresent(result.groups[1].variants[1].ratio), 1);
        expect(builds.base).toStrictEqual({
            module: BASE,
            url: pathToFileURL(resolve(BASE)).href
        });
        expect(builds.head.module).toBe(HEAD);
        expect(builds.loadedFirst).toStrictEqual(['base']);
        expect(builds.variants.map(({ group, variant }) => [group, variant])).toStrictEqual([
            ['calls', 'sum'],
            ['calls', 'sort']
        ]);
    });

    it("says whether head was faster or slower beyond the A/A copy's noise, or within it", async () => {
        const { result } = await compare();
        const [sum, sort] = expectPresent(result.builds).variants;

        expect([sum.differences, sum.difference]).toStrictEqual([['faster'], 'faster']);
        expect([sort.differences, sort.difference]).toStrictEqual([
            ['within noise'],
            'within noise'
        ]);
        expectClose(expectPresent(sum.ratios[0]), 0.5);
        expect(sum.aa?.ratios).toStrictEqual(result.groups[0].variants.slice(2).map(v => v.ratio));
    });

    it("prints the builds, the pairs' tables, and head's ratio to base", async () => {
        const { lines } = await compare();

        expect(lines[1]).toBe(
            `Comparing head, ${HEAD}, with base, ${BASE}: each group is a variant of the two, as group / variant, of base, head, and base's A/A copy. This process loaded base first.`
        );
        expect(lines).toContain(
            'calls / sum: 6 rounds, by the fastest round (every call under 1 µs and 1 KiB)'
        );
        const at = lines.indexOf('calls: 1 process, by the fastest round');
        expect(at, lines.join('\n')).not.toBe(-1);
        expect(lines.slice(at + 1).map(line => line.trim().split(/\s{2,}/))).toStrictEqual([
            ['ratio', '95% interval', 'A/A interval'],
            ['sum', '0.50×', '0.50–0.50', '1.00–1.00'],
            ['sort', '1.00×', '1.00–1.00', '1.00–1.00'],
            ["sum: head faster, beyond the A/A copy's noise"],
            ["sort: within the A/A copy's noise"]
        ]);
    });

    it("leaves out the A/A copies with --no-aa, and compares head's interval with 1", async () => {
        const { result, lines } = await compare(['--no-aa']);
        const [sum] = expectPresent(result.builds).variants;

        expect(result.groups[0].variants.map(variant => variant.name)).toStrictEqual([
            'base',
            'head'
        ]);
        expect([sum.aa, sum.difference]).toStrictEqual([null, 'faster']);
        expect(lines).toContain("  sum: head faster, beyond its interval's noise");
    });

    it("calls the function of groups with each build's module as soon as it's loaded, base first", async () => {
        const runtime = new FakeRuntime();
        const made: string[] = [];

        await compare([], build => {
            made.push(build.NAME);
            return groupsOf(runtime)(build);
        });

        expect(made).toStrictEqual(['base', 'head']);
    });

    it('selects pairs by their names, as group / variant, with --filter', async () => {
        const { result } = await compare(['--filter', 'sort$']);

        expect(result.groups.map(group => group.name)).toStrictEqual(['calls / sort']);
        expect(expectPresent(result.builds).variants.map(variant => variant.variant)).toStrictEqual(
            ['sort']
        );
        expect(result.options.filter).toBe('sort$');
    });

    it("keeps a variant's setup and teardown with the variant as `this`", async () => {
        const runtime = new FakeRuntime();
        const seen: unknown[] = [];
        const variant = (build: Build): Variant => {
            const own = {
                ...runtime.variant('sum', build.NANOSECONDS.sum),
                setup(this: unknown) {
                    seen.push(this === own);
                },
                teardown(this: unknown) {
                    seen.push(this === own);
                }
            };
            return own;
        };

        await compare([], build => [{ name: 'calls', variants: [variant(build)] }]);

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every(Boolean)).toBe(true);
    });

    it('rejects builds that it would compare with themselves, or without a module, before it makes groups', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        try {
            const link = join(directory, 'base.ts');
            await symlink(resolve(BASE), link);

            for (const [args, error] of [
                [
                    ['--base', BASE],
                    /^Expected --base and --head to name the modules of the builds to compare/
                ],
                [['--base', '', '--head', HEAD], /got --base "" and --head/],
                [
                    ['--base', BASE, '--head', BASE],
                    /^Expected --base and --head to name two builds, but both are /
                ],
                [['--base', BASE, '--head', link], /but both are .*base\.ts$/],
                [
                    ['--base', 'test', '--head', HEAD],
                    /^Expected --base to name a module's file, got the directory /
                ],
                [
                    ['--base', join(directory, 'missing.ts'), '--head', HEAD],
                    /^Expected --base to name a module, got /
                ]
            ] as const) {
                let made = 0;
                const run = compareBuilds(
                    () => {
                        made++;
                        return [];
                    },
                    { args: [...QUICK, ...args], print: () => undefined }
                );

                await expect(run, args.join(' ')).rejects.toThrow(error);
                expect(made).toBe(0);
            }
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    it('rejects a variant whose run is the same function in both builds', async () => {
        const shared = { name: 'shared', run: () => 1 };

        const run = compare([], () => [{ name: 'calls', variants: [shared] }]);

        await expect(run).rejects.toThrow(
            `Expected the variant "shared" of group "calls" to run each build's own code, but both builds gave it the same run`
        );
    });

    it('rejects builds whose groups or variants differ, or that set them otherwise', async () => {
        const runtime = new FakeRuntime();
        const call = (name: string, settings: Partial<Group> = {}): Group => ({
            name: 'calls',
            variants: [runtime.variant(name, 10)],
            ...settings
        });
        const cases: Array<[(build: Build) => Group[], RegExp]> = [
            [build => (build.NAME === 'base' ? [call('sum')] : []), /but only base made "calls"$/],
            [
                build => [call(build.NAME === 'base' ? 'sum' : 'total')],
                /same variants of group "calls", but only base made "sum"$/
            ],
            [
                () => [call('sum'), call('sum')],
                /^Expected the groups of base to have different names, but "calls" repeats$/
            ],
            [
                build => [call('sum', { lead: build.NAME === 'base' ? 'median' : undefined })],
                /set the same lead and aa in both builds, got lead median and aa by the run in base/
            ],
            [() => [call('sum', { variants: [] })], /^Expected group "calls" to have variants$/],
            [
                build => [
                    {
                        name: 'calls',
                        variants: [
                            build.NAME === 'base'
                                ? runtime.variant('sum', 10)
                                : runtime.asyncVariant('sum', 10)
                        ]
                    }
                ],
                /to be async in both builds or in neither, got head only$/
            ]
        ];

        for (const [groups, error] of cases) {
            await expect(compare([], groups), String(error)).rejects.toThrow(error);
        }
    });

    it('rejects --base and --head in a script that calls bench()', async () => {
        const runtime = new FakeRuntime();

        const run = bench([{ name: 'group', variants: [runtime.variant('a', 10)] }], {
            args: [...QUICK, '--base', BASE],
            runtime,
            print: () => undefined
        });

        await expect(run).rejects.toThrow(/^Expected no --base or --head for bench\(\)/);
    });
});

describe('firstBuildIn', () => {
    it.prop([fc.integer({ min: 1, max: 1000 })])(
        'loads base first in the first process, and each build first in turn after it',
        process => {
            expect(firstBuildIn(process)).toBe(process % 2 === 1 ? 'base' : 'head');
            expect(firstBuildIn(process + 1)).not.toBe(firstBuildIn(process));
        }
    );
});

/** An interval around a ratio, as wide as `width` either way */
function around(ratio: number, width: number): [number, number] {
    return [ratio - width, ratio + width];
}

/**
 * A run's results whose only group is a pair of `calls / sum`, with head's
 * ratios and the A/A copy's in each process, and intervals of `width`
 * around them, or without an A/A copy for null
 */
function pairResult(
    head: readonly number[],
    aa: readonly number[] | null,
    { width = 0.01, lead = 'median' }: { width?: number; lead?: Lead } = {}
): RunResult {
    const across = (
        name: string,
        role: 'reference' | 'variant' | 'aa',
        ratios: readonly number[]
    ): VariantAcrossProcesses => {
        const sorted = ratios.toSorted((a, b) => a - b);
        return {
            name,
            role,
            ratios,
            intervals: ratios.map(ratio => (role === 'reference' ? null : around(ratio, width))),
            median: sorted.length < 3 ? null : sorted[Math.ceil((sorted.length - 1) / 2)],
            range: [sorted[0], sorted[sorted.length - 1]] as [number, number]
        };
    };
    const group: GroupAcrossProcesses = {
        name: 'calls / sum',
        lead,
        leads: head.map(() => lead),
        variants: [
            across(
                'base',
                'reference',
                head.map(() => 1)
            ),
            across('head', 'variant', head),
            ...(aa == null ? [] : [across('base A/A', 'aa', aa)])
        ]
    };

    return {
        schema: 8,
        date: '',
        runtime: {
            name: 'Fake',
            version: '',
            engine: '',
            platform: '',
            arch: '',
            cpu: '',
            flags: [],
            processState: []
        },
        options: {
            rounds: 6,
            warmupRounds: 1,
            sampleTime: 0.01,
            aa: aa != null,
            heap: false,
            filter: ''
        },
        groups: [],
        processes: { runs: [], groups: [group] },
        builds: null,
        v8Report: null
    };
}

/** The comparison of a pair's results, in processes that load each build first in turn */
function comparisonOf(result: RunResult): BuildComparison {
    const count = expectPresent(result.processes).groups[0].variants[0].ratios.length;
    const build = { module: 'base.js', url: 'file:///base.js' };

    return withBuilds(result, {
        base: build,
        head: { module: 'head.js', url: 'file:///head.js' },
        loadedFirst: Array.from({ length: count }, (_, i) => firstBuildIn(i + 1)),
        origins: [{ group: 'calls', variant: 'sum' }]
    }).builds;
}

describe('withBuilds', () => {
    it("says head was faster or slower where every process's interval lies apart from the A/A copy's", () => {
        const [slower] = comparisonOf(pairResult([1.1, 1.12, 1.09], [1, 1.01, 0.99])).variants;
        const [faster] = comparisonOf(pairResult([0.9, 0.91], [1, 1])).variants;

        expect([slower.differences, slower.difference]).toStrictEqual([
            ['slower', 'slower', 'slower'],
            'slower'
        ]);
        expect([faster.differences, faster.difference]).toStrictEqual([
            ['faster', 'faster'],
            'faster'
        ]);
    });

    it("says so where head's ratio lies on one side of the A/A copy's in enough processes, though not every interval shows it", () => {
        // Intervals of 1% either way overlap the A/A copy's at 1.015
        const ratio = (above: number, count: number): RunResult =>
            pairResult(
                Array.from({ length: count }, (_, i) => (i < above ? 1.015 : 0.995)),
                Array.from({ length: count }, () => 1)
            );

        for (const [above, count, difference] of [
            [6, 6, 'slower'],
            [5, 5, 'within noise'],
            [9, 10, 'slower'],
            [8, 10, 'within noise'],
            [3, 3, 'within noise']
        ] as const) {
            const [variant] = comparisonOf(ratio(above, count)).variants;

            expect(variant.differences.every(other => other === 'within noise')).toBe(true);
            expect(variant.difference, `${above} of ${count}`).toBe(difference);
        }
    });

    it('compares head with 1 without an A/A copy', () => {
        const [variant] = comparisonOf(pairResult([1.05, 1.004], null)).variants;

        expect(variant.aa).toBeNull();
        expect(variant.differences).toStrictEqual(['slower', 'within noise']);
    });

    it('gives no difference where no process has an interval', () => {
        const result = pairResult([1.5], [1]);
        const [, head] = expectPresent(result.processes).groups[0].variants;
        const withoutIntervals = {
            ...result,
            processes: {
                runs: [],
                groups: [
                    {
                        ...expectPresent(result.processes).groups[0],
                        variants: [{ ...head, role: 'variant' as const, intervals: [null] }]
                    }
                ]
            }
        };

        const [variant] = comparisonOf(withoutIntervals).variants;

        expect([variant.differences, variant.difference]).toStrictEqual([[null], null]);
    });

    it.prop([
        fc.array(fc.double({ min: 0.5, max: 2, noNaN: true }), { minLength: 1, maxLength: 12 })
    ])('gives the median ratio of the processes that loaded each build first', ratios => {
        const { loadOrder } = comparisonOf(pairResult(ratios, null)).variants[0];
        const medianOf = (values: number[]): number | null =>
            values.length === 0
                ? null
                : values.toSorted((a, b) => a - b)[Math.ceil((values.length - 1) / 2)];

        expect(loadOrder.base).toBe(medianOf(ratios.filter((_, i) => i % 2 === 0)));
        expect(loadOrder.head).toBe(medianOf(ratios.filter((_, i) => i % 2 === 1)));
    });

    it('says the ratios depend on the load order where one order lies apart from the other, with 4 processes of each or more', () => {
        // Processes 1, 3, … load base first
        const alternating = (count: number, base: number, head: number): number[] =>
            Array.from({ length: count }, (_, i) => (i % 2 === 0 ? base : head) + i * 0.0001);

        for (const [ratios, apart] of [
            [alternating(8, 1.1, 1), true],
            [alternating(10, 0.9, 1), true],
            [alternating(6, 1.1, 1), false],
            [[1.1, 1, 1.1, 1, 0.99, 1.01, 1.1, 1], false]
        ] as const) {
            const { loadOrder } = comparisonOf(pairResult(ratios, null)).variants[0];

            expect(loadOrder.apart, ratios.join(' ')).toBe(apart);
        }
    });
});

describe('formatBuilds', () => {
    it("prints each variant's ratio in each process, their median and range, and what they showed", () => {
        const lines = formatBuilds(
            comparisonOf(pairResult([1.1, 1.12, 1.09, 1.11], [1, 1.01, 0.99, 1]))
        );

        expect(lines.slice(0, 2)).toStrictEqual([
            '',
            "Head against base in 4 processes: each variant's ratio of head's time to base's in each, by the statistic that its pair leads with in the first, the median of the 4 ratios, and their range. Processes 1 and 3 loaded base first, and 2 and 4 head first."
        ]);
        expect(lines.slice(3).map(line => line.trim().split(/\s{2,}/))).toStrictEqual([
            ['calls: 4 processes, by the median round'],
            ['1', '2', '3', '4', 'median', 'range'],
            ['sum', '1.10×', '1.12×', '1.09×', '1.11×', '1.11×', '1.09–1.12'],
            [
                "sum: head slower, beyond the A/A copy's noise: of 4 processes, its ratio lay above the A/A copy's in 4, and its interval apart from the A/A copy's in 4"
            ]
        ]);
    });

    it('leaves out the median of 2 processes', () => {
        const lines = formatBuilds(comparisonOf(pairResult([1.004, 0.998], [1, 1])));

        expect(lines.slice(4).map(line => line.trim().split(/\s{2,}/))).toStrictEqual([
            ['1', '2', 'range'],
            ['sum', '1.00×', '1.00×', '1.00–1.00'],
            [
                "sum: within the A/A copy's noise: of 2 processes, its ratio lay above the A/A copy's in 1 and below in 1, and its interval apart from the A/A copy's in none"
            ]
        ]);
    });

    it('notes a variant whose ratio depends on which build loaded first', () => {
        const lines = formatBuilds(
            comparisonOf(
                pairResult([1.1, 1, 1.11, 1.01, 1.12, 1.02, 1.1, 1], [1, 1, 1, 1, 1, 1, 1, 1])
            )
        );

        expect(lines.at(-1)).toBe(
            '  sum: 1.11× in the processes that loaded base first, and 1.01× in those that loaded head first: which build a process loads first changes the ratio'
        );
    });

    it('names the lead of each variant whose pair leads with another statistic than the first', () => {
        const median = comparisonOf(pairResult([1.1], [1]));
        const fastest = comparisonOf(pairResult([1.2], [1], { lead: 'fastest' }));
        const lines = formatBuilds({
            ...median,
            variants: [median.variants[0], { ...fastest.variants[0], variant: 'sort' }]
        });

        expect(lines).toContain('calls: 1 process, by the round that each pair leads with');
        expect(lines).toContain('  sort: by the fastest round');
    });
});

describe('compareBuilds across processes', () => {
    it("loads each build first in turn, and prints head's ratio to base in each process", async () => {
        const directory = await mkdtemp(join(tmpdir(), 'benk-'));
        try {
            const order = join(directory, 'order');
            const path = join(directory, 'results.json');
            const { stdout } = await promisify(execFile)(
                process.execPath,
                [
                    '--no-strip-types',
                    '--import',
                    '@snovader/node-hooks/register',
                    join('test', 'fixtures', 'compare-builds.ts'),
                    ...QUICK,
                    ...BUILDS,
                    '--processes',
                    '4',
                    '--json',
                    path
                ],
                { cwd: REPOSITORY, env: { ...process.env, BUILDS_ORDER: order } }
            );
            const lines = stdout.split('\n');
            const result = JSON.parse(await readFile(path, 'utf8')) as RunResult;
            const builds = expectPresent(result.builds);

            // Processes 2 to 4 record theirs before the first, which runs them
            expect((await readFile(order, 'utf8')).trimEnd().split('\n')).toStrictEqual([
                'head base',
                'base head',
                'head base',
                'base head'
            ]);
            expect(builds.loadedFirst).toStrictEqual(['base', 'head', 'base', 'head']);
            expect(result.schema).toBe(8);
            for (const ratio of builds.variants[0].ratios) {
                expectClose(expectPresent(ratio), 0.5);
            }
            expect(builds.variants.map(variant => variant.difference)).toStrictEqual([
                'faster',
                'within noise'
            ]);
            // The comparison takes the place of the ratios of each pair across processes
            expect(lines).toContain('calls: 4 processes, by the fastest round');
            expect(lines.some(line => line.startsWith('calls / sum: 4 processes'))).toBe(false);
            expect(lines).toContain(
                "  sum: head faster, beyond the A/A copy's noise: of 4 processes, its ratio lay below the A/A copy's in 4, and its interval apart from the A/A copy's in 4"
            );
        } finally {
            await rm(directory, { recursive: true });
        }
    });
});
