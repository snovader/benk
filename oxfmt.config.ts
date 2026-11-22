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
        // A bundle as rolldown writes it, whose positions the fixtures of
        // its traced run name
        'test/fixtures/v8/bundled/bench.mjs'
    ],
    // The package imports itself by the name that it exports, after other
    // packages and before its private paths
    sortImports: { ...oxfmt.sortImports, internalPattern: ['benk'] }
});
