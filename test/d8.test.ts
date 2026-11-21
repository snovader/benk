// d8's runtime, which times variants in d8, the V8 shell. Its timer loops
// run in Node too, where the first tests time them. Its description reads
// d8's globals, so the others bundle `d8-driver.ts` and run it in d8. They
// need `d8` on the PATH, as `brew install v8` puts it, and are skipped
// without it, as in CI. Times vary, so they check only what doesn't.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import { build } from 'rolldown';
import { measureGroup, type RunResult } from 'benk/core';
import { D8Runtime } from 'benk/d8';
import { expectPresent } from './expectations.ts';

const QUICK = { sampleTime: 0.2, warmupRounds: 2, rounds: 6 };

/** What d8 says of itself, and whether 2³⁰ is a small integer in it */
interface Shell {
    readonly version: string;
    readonly platform: string;
    readonly smallIntegerBits: number;
}

/**
 * Asks d8 for its version and platform, and for the bits of its small
 * integers by `%IsSmi()`, which reads V8's own tag of a value, or returns
 * undefined where d8 isn't installed
 */
function askShell(): Shell | undefined {
    const script = `print(JSON.stringify({
        version: version(),
        platform: os.name,
        smallIntegerBits: %IsSmi(2 ** 30) ? 32 : 31
    }))`;
    const shell = spawnSync('d8', ['--allow-natives-syntax', '-e', script], {
        encoding: 'utf8'
    });

    return shell.error ? undefined : (JSON.parse(shell.stdout) as Shell);
}

/** What `d8-driver.ts` prints */
interface DriverOutput {
    readonly result: RunResult;
    readonly description: string;
    readonly table: readonly string[];
}

/**
 * Bundles `d8-driver.ts` with benk as this process resolves it, from its
 * source or from its bundle, runs it in d8, and returns what it prints
 */
async function runDriver(): Promise<DriverOutput> {
    const { output } = await build({
        input: join(import.meta.dirname, 'd8-driver.ts'),
        platform: 'neutral',
        resolve: {
            alias: {
                'benk/core': fileURLToPath(import.meta.resolve('benk/core')),
                'benk/d8': fileURLToPath(import.meta.resolve('benk/d8'))
            }
        },
        write: false,
        logLevel: 'silent'
    });

    const directory = mkdtempSync(join(tmpdir(), 'benk-d8-'));
    try {
        const script = join(directory, 'driver.mjs');
        writeFileSync(script, output[0].code);
        const run = spawnSync('d8', [script], { encoding: 'utf8' });

        expect(run.status, run.stderr || run.stdout).toBe(0);
        return JSON.parse(run.stdout) as DriverOutput;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe('D8Runtime', () => {
    it.prop([fc.nat({ max: 10_000 })])(
        'calls a variant as often as a loop is told to',
        repetitions => {
            let calls = 0;
            const elapsed = new D8Runtime().createTimer()(() => calls++, repetitions);

            expect(calls).toBe(repetitions);
            expect(elapsed).toBeGreaterThanOrEqual(0);
        }
    );

    it.prop([fc.nat({ max: 1000 })])(
        'awaits each call of an async variant before the next',
        async repetitions => {
            let calls = 0;
            let pending = 0;
            let mostPending = 0;
            const run = async (): Promise<void> => {
                calls++;
                pending++;
                mostPending = Math.max(mostPending, pending);
                await Promise.resolve();
                pending--;
            };

            const elapsed = await new D8Runtime().createAsyncTimer()(run, repetitions);

            expect(calls).toBe(repetitions);
            expect(mostPending).toBe(Math.min(repetitions, 1));
            expect(elapsed).toBeGreaterThanOrEqual(0);
        }
    );

    it.prop([fc.array(fc.boolean(), { minLength: 2, maxLength: 20 })])(
        'gives each loop a source of its own',
        asyncLoops => {
            const runtime = new D8Runtime();
            const sources = asyncLoops.map(async =>
                String(async ? runtime.createAsyncTimer() : runtime.createTimer())
            );

            expect(new Set(sources).size).toBe(sources.length);
        }
    );

    it('times sync and async calls, and counts no heap bytes', async () => {
        let count = 0;
        const runtime = new D8Runtime();
        const result = await measureGroup(
            {
                name: 'calls',
                variants: [
                    { name: 'sync', run: () => (count = (count + 1) % 1024) },
                    { name: 'async', async: true, run: () => Promise.resolve(count) }
                ]
            },
            { ...QUICK, runtime }
        );

        expect(runtime.heap).toBeUndefined();
        for (const { summary, heapBytes } of result.variants) {
            expect(summary.fastest).toBeGreaterThan(0);
            expect(summary.fastest).toBeLessThan(1e6);
            expect(heapBytes).toBeNull();
        }
        expect(expectPresent(result.timerResolution)).toBeGreaterThan(0);
    });
});

const shell = askShell();

/** The driver's run, which the tests in d8 share */
let driverRun: Promise<DriverOutput> | undefined;

describe.runIf(shell)('D8Runtime in d8', () => {
    it('describes d8, and the bits of its small integers', async () => {
        const { version, platform, smallIntegerBits } = expectPresent(shell);
        const { result, description } = await (driverRun ??= runDriver());

        expect(result.runtime).toStrictEqual({
            name: 'd8',
            version,
            engine: `V8 ${version}`,
            platform,
            arch: 'unknown',
            cpu: 'unknown',
            flags: ['unknown'],
            processState: [`${smallIntegerBits}-bit small integers`]
        });
        expect(description.split('\n')[0]).toBe(
            `d8 ${version}, V8 ${version}, ${platform} unknown, unknown, with unknown. Process state: ${smallIntegerBits}-bit small integers.`
        );
    });

    it('times sync and async calls, and prints a table without heap bytes', async () => {
        const { result, table } = await (driverRun ??= runDriver());
        const [group] = result.groups;
        const rows = group.variants.map(({ name }) =>
            table.find(line => line.startsWith(`  ${name.padEnd(16)}`))
        );

        expect(group.variants.map(({ name }) => name)).toStrictEqual(['sync', 'async', 'sync A/A']);
        for (const { summary, heapBytes } of group.variants) {
            expect(summary.fastest).toBeGreaterThan(0);
            expect(summary.fastest).toBeLessThan(1e6);
            expect(heapBytes).toBeNull();
        }
        expect(expectPresent(group.timerResolution)).toBeGreaterThan(0);
        expect(
            rows.every(row => row?.endsWith('–')),
            table.join('\n')
        ).toBe(true);
    });
});
