// The options of the command line, which `benk` and `benk/core` read the
// same way, as Node's `parseArgs()` read them before benk read them itself,
// for runtimes without `node:util`. `parseArgs()` is the reference here.
import { parseArgs } from 'node:util';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import * as benk from 'benk';
import * as core from 'benk/core';

/** The options of the command line, as `parseOptions()` passed them to `parseArgs()` */
const REFERENCE = {
    allowNegative: true,
    options: {
        rounds: { type: 'string' },
        'warmup-rounds': { type: 'string' },
        'sample-ms': { type: 'string' },
        filter: { type: 'string' },
        json: { type: 'string' },
        processes: { type: 'string' },
        aa: { type: 'boolean' },
        heap: { type: 'boolean' },
        'v8-report': { type: 'boolean' },
        'v8-filter': { type: 'string' },
        'v8-check': { type: 'boolean' },
        'v8-max-bytecode': { type: 'string' }
    }
} as const;

const ENTRY_POINTS = [
    ['benk', benk.parseOptions],
    ['benk/core', core.parseOptions]
] as const;

const FLAGS = ['aa', 'heap', 'v8-report', 'v8-check'];
const WITH_VALUES = [
    'rounds',
    'warmup-rounds',
    'sample-ms',
    'filter',
    'json',
    'processes',
    'v8-filter',
    'v8-max-bytecode'
];

/** Values, of options or not, some of which look like options */
const value = fc.oneof(
    fc.constantFrom('', '-', '--', '-1', '0', '3', '2.5', 'x', '^a', '[', 'a=b', '--rounds', '-x'),
    fc.string({ maxLength: 4 })
);

/** Names of options, of negated ones, and of none */
const name = fc.oneof(
    fc.constantFrom(...FLAGS, ...WITH_VALUES),
    fc.constantFrom(...FLAGS, ...WITH_VALUES).map(option => `no-${option}`),
    fc.constantFrom('round', 'no-', '', '__proto__', 'constructor', '=x')
);

/** An argument of any kind, which is more often wrong than not */
const anyArgument = fc.oneof(
    name.map(option => `--${option}`),
    fc.tuple(name, value).map(([option, text]) => `--${option}=${text}`),
    value,
    fc.constantFrom('--', '-r', '-abc')
);

/** An option, in each of the forms that it can take, or an argument of any kind */
const option = fc.oneof(
    {
        arbitrary: fc
            .tuple(fc.boolean(), fc.constantFrom(...FLAGS))
            .map(([negated, flag]) => [`--${negated ? 'no-' : ''}${flag}`]),
        weight: 3
    },
    {
        arbitrary: fc
            .tuple(fc.constantFrom(...WITH_VALUES), value)
            .map(([given, text]) => [`--${given}`, text]),
        weight: 3
    },
    {
        arbitrary: fc
            .tuple(fc.constantFrom(...WITH_VALUES), value)
            .map(([given, text]) => [`--${given}=${text}`]),
        weight: 2
    },
    { arbitrary: anyArgument.map(argument => [argument]), weight: 2 }
);

const argumentLists = fc.array(option, { maxLength: 5 }).map(options => options.flat());

/**
 * The arguments that set what `parseArgs()` reads from `args`, each option
 * in one argument, as `--name=value`, `--name` or `--no-name`, or undefined
 * if it rejects them, with a `TypeError`
 */
function plainArguments(args: readonly string[]): string[] | undefined {
    let values: Record<string, string | boolean | undefined>;
    try {
        ({ values } = parseArgs({ ...REFERENCE, args: [...args] }));
    } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        return undefined;
    }

    return Object.entries(values).map(([option, set]) =>
        typeof set === 'string' ? `--${option}=${set}` : `--${set ? '' : 'no-'}${option}`
    );
}

/** What `parse()` returns, or the class and message of what it throws */
function outcome(parse: () => benk.CommandOptions): unknown {
    try {
        return parse();
    } catch (error) {
        return error instanceof Error ? `${error.name}: ${error.message}` : error;
    }
}

describe('parseOptions', () => {
    it.prop([argumentLists], { numRuns: 1000 })(
        "reads arguments as Node's parseArgs() does",
        args => {
            const plain = plainArguments(args);

            for (const [entry, parseOptions] of ENTRY_POINTS) {
                const read = outcome(() => parseOptions(args));
                const rejected = typeof read === 'string' && read.startsWith('TypeError: ');

                expect(rejected, `${entry}: ${String(read)}`).toBe(plain == null);
                if (plain != null) {
                    expect(read, entry).toStrictEqual(outcome(() => parseOptions(plain)));
                }
            }
        }
    );

    it('reads the same options from benk and benk/core', () => {
        const args = ['--rounds', '7', '--filter=^sum', '--no-heap', '--json', '-'];

        expect(core.parseOptions(args)).toStrictEqual(benk.parseOptions(args));
    });

    it('names the options when it rejects one', () => {
        const parse = (): unknown => core.parseOptions(['--round', '7']);

        expect(parse).toThrow(TypeError);
        expect(parse).toThrow(/, got --round$/);
        expect(parse).toThrow(
            /--rounds, --warmup-rounds, --sample-ms, --filter, --json, --processes, --base, --head, --v8-filter, --v8-max-bytecode, --\[no-\]aa/
        );
    });

    it('asks for = before a value that looks like an option', () => {
        const parse = (): unknown => core.parseOptions(['--warmup-rounds', '-1']);

        expect(parse).toThrow(TypeError);
        expect(parse).toThrow('--warmup-rounds=-1');
        expect(() => core.parseOptions(['--warmup-rounds=-1'])).toThrow(RangeError);
    });
});
