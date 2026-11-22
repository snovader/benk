// Command-line arguments read into options' values, by the conventions of
// Node's `parseArgs()` with `allowNegative`, which d8 and other runtimes
// don't have. `node:util` is Node's, so the core reads them itself.

/** The options that arguments may set, by name, without their `--` */
export interface ArgumentSpec {
    /** Options that take a value, as `--rounds 51` */
    readonly values: ReadonlySet<string>;
    /** Options that take none, as `--aa`, and that `--no-aa` negates */
    readonly flags: ReadonlySet<string>;
}

/** What arguments set: only the options that they name */
export interface ArgumentValues {
    readonly values: ReadonlyMap<string, string>;
    readonly flags: ReadonlyMap<string, boolean>;
}

/** An option as an argument names it, before it's checked */
interface Token {
    /** The option's name, without `--` */
    readonly name: string;
    /** The argument that named it, for errors */
    readonly raw: string;
    readonly value: string | undefined;
    /** Whether the value came after `=`, in the same argument */
    readonly inline: boolean;
}

/**
 * Reads arguments as Node's `parseArgs()` does in strict mode, with
 * `allowNegative`, for long options only:
 *
 * - An option with a value takes it after `=`, or as the next argument,
 *   whatever it is. A next argument that starts with `-`, other than `-`
 *   itself, is taken for a mistyped option, and needs `=`.
 * - A flag takes no value, and `--no-` before its name sets it to false.
 * - The last of an option's arguments counts.
 * - `--` ends the options, and is an error before any other argument, as
 *   are short options and arguments that aren't options.
 *
 * Its errors are `TypeError`s, as `parseArgs()`'s are, with messages of
 * benk's own.
 *
 * @throws {TypeError} If an argument isn't one of the options, a value is
 * missing or mistyped, or a flag has one.
 */
export function readArguments(
    args: readonly string[],
    spec: ArgumentSpec
): ArgumentValues {
    const values = new Map<string, string>();
    const flags = new Map<string, boolean>();

    for (const token of tokenize(args, spec)) {
        if (spec.values.has(token.name)) {
            values.set(token.name, checkedValue(token));
        } else {
            const flag = namedFlag(token, spec);
            if (token.value != null) {
                throw new TypeError(
                    `Expected --${flag.name} without a value, got ${token.raw}`
                );
            }
            flags.set(flag.name, flag.set);
        }
    }

    return { values, flags };
}

/**
 * The options that the arguments name, in their order. It yields each
 * before it reads the next argument, so that the first argument that's
 * wrong, of any kind, is the one that an error names.
 *
 * @throws {TypeError} If an argument isn't a long option, or comes after
 * `--`.
 */
function* tokenize(
    args: readonly string[],
    spec: ArgumentSpec
): Generator<Token, void, undefined> {
    for (let at = 0; at < args.length; at++) {
        const arg = args[at];
        if (arg === '--' && at === args.length - 1) {
            return;
        }
        if (arg === '--' || !arg.startsWith('--')) {
            const wrong = arg === '--' ? `${args[at + 1]} after --` : arg;
            throw new TypeError(
                `Expected an option, one of ${optionNames(spec)}, got ${wrong}`
            );
        }

        const equals = arg.indexOf('=');
        const name = arg.slice(2, equals === -1 ? undefined : equals);
        if (equals !== -1) {
            yield {
                name,
                raw: arg,
                value: arg.slice(equals + 1),
                inline: true
            };
        } else if (spec.values.has(name) && at + 1 < args.length) {
            at++;
            yield { name, raw: arg, value: args[at], inline: false };
        } else {
            yield { name, raw: arg, value: undefined, inline: false };
        }
    }
}

/**
 * The value of an option that takes one
 *
 * @throws {TypeError} If it has none, or one after a space that starts with
 * `-`, which is more likely an option than a value.
 */
function checkedValue({ name, value, inline }: Token): string {
    if (value == null) {
        throw new TypeError(`Expected a value after --${name}, got none`);
    }
    if (!inline && value.length > 1 && value.startsWith('-')) {
        throw new TypeError(
            `Expected a value after --${name}, got ${value}, which looks like an option: write --${name}=${value} for such a value`
        );
    }

    return value;
}

/**
 * The flag that a token names, and what it sets the flag to: false after
 * `--no-`
 *
 * @throws {TypeError} If it's no flag, negated or not.
 */
function namedFlag(
    { name, raw }: Token,
    spec: ArgumentSpec
): { readonly name: string; readonly set: boolean } {
    if (spec.flags.has(name)) {
        return { name, set: true };
    }

    const negated = name.startsWith('no-') ? name.slice(3) : undefined;
    if (negated == null || !spec.flags.has(negated)) {
        throw new TypeError(
            `Expected an option, one of ${optionNames(spec)}, got ${raw}`
        );
    }

    return { name: negated, set: false };
}

/** The options, as an error lists them */
function optionNames({ values, flags }: ArgumentSpec): string {
    return [
        ...Array.from(values, name => `--${name}`),
        ...Array.from(flags, name => `--[no-]${name}`)
    ].join(', ');
}
