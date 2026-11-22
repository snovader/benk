import oxfmt from '@snovader/oxc-config/oxfmt';
import { defineConfig } from 'oxfmt';

export default defineConfig({
    ...oxfmt,
    ignorePatterns: [
        '.yarn',
        'dist',
        // Yarn writes these in a format of its own
        '**/package.json',
        // Prose wrapped by hand
        '**/*.md',
        // Bundles as rolldown writes them, whose positions the fixtures of
        // their traced runs name
        'test/fixtures/v8/bundled/bench.mjs',
        'test/fixtures/v8/d8/bench.mjs',
        // V8's natives syntax, as `%OptimizeFunctionOnNextCall()`, which
        // neither tool parses
        'test/fixtures/v8/over-budget.mjs'
    ],
    // The package imports itself by the name that it exports, after other
    // packages and before its private paths
    sortImports: { ...oxfmt.sortImports, internalPattern: ['benk'] }
});
