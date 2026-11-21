import oxlint from '@snovader/oxc-config/oxlint';
import hypotes from '@snovader/oxc-config/oxlint/hypotes';
import { defineConfig } from 'oxlint';

/** Imports of an entry point by its private path */
const ENTRY_POINTS = {
    regex: '^#source/(index|core)$',
    message:
        'Import an entry point by the name that the package exports it under.'
};

export default defineConfig({
    // The tests run on hypotes, whose rules see what they declare and expect
    extends: [oxlint, hypotes],
    ignorePatterns: ['.yarn', 'dist'],
    rules: {
        // A module in a parent directory is imported by a private path of
        // package.json's `imports`, such as `#source/core/types`, rather than
        // by `../`
        'import/no-relative-parent-imports': 'error',
        // An entry point is imported by the name that package.json's
        // `exports` give it, `benk` or `benk/core`, which names the bundle
        // when the tests run on it
        'eslint/no-restricted-imports': ['error', { patterns: [ENTRY_POINTS] }]
    },
    overrides: [
        {
            // The core runs on any JavaScript runtime: what's particular to
            // Node, such as `node:v8`'s heap statistics and timer loops
            // compiled with `new Function`, stays in `source/node`. The
            // core's entry point is as free of them.
            files: ['source/core/**', 'source/core.ts'],
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
