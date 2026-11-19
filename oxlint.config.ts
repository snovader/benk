import { defineConfig } from 'oxlint';

/** Imports of the entry point by its private path */
const ENTRY_POINTS = {
    regex: '^#source/index$',
    message:
        'Import the entry point by the name that the package exports it under.'
};

export default defineConfig({
    ignorePatterns: ['.yarn', 'dist'],
    options: {
        // Rules marked as type-aware run through tsgolint, on TypeScript 7
        typeAware: true,
        reportUnusedDisableDirectives: 'error'
    },
    plugins: [
        'eslint',
        'typescript',
        'unicorn',
        'oxc',
        'import',
        'jsdoc',
        'promise'
    ],
    // Every rule of these categories runs, except those turned off below. Rules
    // of the style and restriction categories run only when listed, as most
    // describe a house style other than this one, and a new version of oxlint
    // adds rules to them.
    categories: {
        correctness: 'error',
        suspicious: 'error',
        pedantic: 'error',
        perf: 'error'
    },
    rules: {
        // Arrays of simple types use `T[]` and `readonly T[]`, and all others
        // `Array<T>` and `ReadonlyArray<T>`: `number[][]` and `Buffer[]`, but
        // `Array<Span<Date>>` and `Array<[key: string, value: number]>`
        'typescript/array-type': ['error', { default: 'array-simple' }],
        // Declarations, class members, and functions bound to variables declare
        // their return types. Inline callbacks don't need one, and neither do
        // functions that TypeScript types from where they appear.
        'typescript/explicit-function-return-type': [
            'error',
            {
                allowExpressions: true,
                allowTypedFunctionExpressions: true,
                allowHigherOrderFunctions: true,
                allowDirectConstAssertionInArrowFunctions: true,
                allowIIFEs: true
            }
        ],
        // A `default` case counts as handling the rest
        'typescript/switch-exhaustiveness-check': [
            'error',
            { considerDefaultExhaustiveForUnions: true }
        ],
        // A `never` is what a check of a value from outside TypeScript prints
        'typescript/restrict-template-expressions': [
            'error',
            { allowNever: true }
        ],
        'typescript/no-confusing-void-expression': [
            'error',
            { ignoreArrowShorthand: true }
        ],
        'eslint/no-inline-comments': 'error',

        // Types at the API's boundaries
        'typescript/consistent-type-definitions': ['error', 'interface'],
        'typescript/consistent-type-imports': 'error',
        'typescript/consistent-type-exports': 'error',
        'typescript/no-import-type-side-effects': 'error',
        'typescript/no-inferrable-types': 'error',
        'typescript/no-explicit-any': 'error',
        'typescript/prefer-readonly': 'error',
        'typescript/consistent-generic-constructors': 'error',
        'typescript/consistent-indexed-object-style': 'error',
        'typescript/no-empty-interface': 'error',
        'typescript/no-namespace': 'error',
        'typescript/prefer-as-const': 'error',
        'typescript/prefer-function-type': 'error',
        'typescript/no-non-null-asserted-nullish-coalescing': 'error',

        // Errors that callers can tell apart, with their causes
        'typescript/only-throw-error': 'error',
        'unicorn/throw-new-error': 'error',
        'unicorn/error-message': 'error',
        'unicorn/prefer-type-error': 'error',
        'eslint/preserve-caught-error': 'error',

        // Modules
        'import/first': 'error',
        'import/no-cycle': 'error',
        'import/no-default-export': 'error',
        'import/no-duplicates': 'error',
        'import/no-empty-named-blocks': 'error',
        'import/no-mutable-exports': 'error',
        'unicorn/prefer-node-protocol': 'error',
        // Files are named in kebab-case, whatever they export, so that an
        // import path reads the same on file systems that ignore case
        'unicorn/filename-case': ['error', { case: 'kebabCase' }],
        // A module in a parent directory is imported by a private path of
        // package.json's `imports`, such as `#source/core/types`, rather than
        // by `../`
        'import/no-relative-parent-imports': 'error',
        // The entry point is imported by the name that package.json's
        // `exports` give it, `benk`, which names the bundle when the tests
        // run on it
        'eslint/no-restricted-imports': ['error', { patterns: [ENTRY_POINTS] }],

        'eslint/curly': 'error',
        'eslint/default-param-last': 'error',
        'eslint/eqeqeq': 'error',
        'eslint/no-else-return': ['error', { allowElseIf: false }],
        'eslint/no-lonely-if': 'error',
        'eslint/no-param-reassign': 'error',
        'eslint/no-useless-computed-key': 'error',
        'eslint/no-useless-constructor': 'error',
        'eslint/no-useless-rename': 'error',
        'eslint/no-var': 'error',
        'eslint/prefer-const': 'error',
        'eslint/prefer-exponentiation-operator': 'error',
        'eslint/prefer-object-has-own': 'error',
        'eslint/prefer-rest-params': 'error',
        'eslint/prefer-spread': 'error',
        'unicorn/no-useless-spread': 'error',
        'unicorn/no-zero-fractions': 'error',
        'unicorn/prefer-bigint-literals': 'error',
        'unicorn/prefer-number-properties': 'error',
        'unicorn/prefer-structured-clone': 'error',

        // Turned off

        // TypeScript reports these itself, with this project's tsconfig
        'eslint/constructor-super': 'off',
        'eslint/getter-return': 'off',
        'eslint/no-class-assign': 'off',
        'eslint/no-const-assign': 'off',
        'eslint/no-delete-var': 'off',
        'eslint/no-dupe-class-members': 'off',
        'eslint/no-dupe-keys': 'off',
        'eslint/no-fallthrough': 'off',
        'eslint/no-func-assign': 'off',
        'eslint/no-import-assign': 'off',
        'eslint/no-new-native-nonconstructor': 'off',
        'eslint/no-obj-calls': 'off',
        'eslint/no-redeclare': 'off',
        'eslint/no-setter-return': 'off',
        'eslint/no-this-before-super': 'off',
        'eslint/no-unreachable': 'off',
        'eslint/no-unsafe-negation': 'off',
        'eslint/no-unsafe-optional-chaining': 'off',
        'eslint/no-unused-labels': 'off',
        'eslint/no-unused-private-class-members': 'off',
        'eslint/no-with': 'off',
        'eslint/use-isnan': 'off',
        'eslint/valid-typeof': 'off',
        'import/default': 'off',
        'import/namespace': 'off',

        // Variants, samples and results are passed as they are
        'typescript/prefer-readonly-parameter-types': 'off',
        // Timer loops compiled with `new Function` are typed by assertion
        'typescript/no-unsafe-type-assertion': 'off',
        // TypeScript checks that every path returns or throws
        'typescript/consistent-return': 'off',
        // Named callbacks, local helpers, named conversions, and typed defaults
        'unicorn/no-array-callback-reference': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'unicorn/prefer-native-coercion-functions': 'off',
        'unicorn/no-useless-undefined': 'off',
        'unicorn/no-object-as-default-parameter': 'off',
        'eslint/no-shadow': 'off',
        // Variants are timed one at a time, as timing them concurrently would
        // time them against each other
        'eslint/no-await-in-loop': 'off',
        // No arbitrary limits of length
        'eslint/max-lines': 'off',
        'eslint/max-lines-per-function': 'off',
        'eslint/max-classes-per-file': 'off',
        'eslint/max-depth': 'off',
        'eslint/max-nested-callbacks': 'off',
        'import/max-dependencies': 'off',
        // Comments are prose, and TypeScript holds the types: JSDoc's tags
        // describe what isn't obvious, rather than every parameter
        'jsdoc/require-param': 'off',
        'jsdoc/require-param-description': 'off',
        'jsdoc/require-param-type': 'off',
        'jsdoc/require-property-description': 'off',
        'jsdoc/require-returns': 'off',
        'jsdoc/require-returns-description': 'off',
        'jsdoc/require-returns-type': 'off',
        'jsdoc/require-throws-type': 'off',
        'jsdoc/require-yields': 'off',
        'jsdoc/require-yields-type': 'off'
    },
    overrides: [
        {
            // Tests pass mocks, and callbacks that return values, to setters
            // that take callbacks that return nothing, and allocate arrays of
            // holes, which `toStrictEqual` tells from arrays of undefined
            files: ['**/*.test.ts'],
            rules: {
                'typescript/strict-void-return': 'off',
                'unicorn/no-new-array': 'off',
                // node:test's `describe` and `it` return promises, which its
                // runner awaits
                'typescript/no-floating-promises': 'off'
            }
        },
        {
            // The core runs on any JavaScript runtime: what's particular to
            // Node, such as `node:v8`'s heap statistics and timer loops
            // compiled with `new Function`, stays in `source/node`
            files: ['source/core/**'],
            rules: {
                'eslint/no-restricted-imports': [
                    'error',
                    {
                        patterns: [
                            ENTRY_POINTS,
                            {
                                regex: '^(node:|#source/node/)',
                                message:
                                    "Keep the core free of Node's modules: a runtime provides them through `Runtime`."
                            }
                        ]
                    }
                ]
            }
        },
        {
            // rolldown, oxlint and oxfmt read their configurations from
            // default exports
            files: ['*.config.ts'],
            rules: {
                'import/no-default-export': 'off'
            }
        }
    ]
});
