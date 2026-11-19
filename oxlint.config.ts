import oxlint from '@snovader/oxc-config/oxlint';
import { defineConfig } from 'oxlint';

/** Imports of the entry point by its private path */
const ENTRY_POINTS = {
    regex: '^#source/index$',
    message:
        'Import the entry point by the name that the package exports it under.'
};

export default defineConfig({
    extends: [oxlint],
    ignorePatterns: ['.yarn', 'dist'],
    rules: {
        // A module in a parent directory is imported by a private path of
        // package.json's `imports`, such as `#source/core/types`, rather than
        // by `../`
        'import/no-relative-parent-imports': 'error',
        // The entry point is imported by the name that package.json's
        // `exports` give it, `benk`, which names the bundle when the tests
        // run on it
        'eslint/no-restricted-imports': ['error', { patterns: [ENTRY_POINTS] }],

        // Turned off

        // Timer loops compiled with `new Function` are typed by assertion
        'typescript/no-unsafe-type-assertion': 'off',
        // Variants are timed one at a time, as timing them concurrently would
        // time them against each other
        'eslint/no-await-in-loop': 'off'
    },
    overrides: [
        {
            // node:test's `describe` and `it` return promises, which its
            // runner awaits
            files: ['**/*.test.ts'],
            rules: {
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
        }
    ]
});
