/**
 * The global symbol that benk-d8 sets before loading the script in a run of
 * `--processes` after the first, whose output it drops
 */
export const D8_PROCESS_RUN = 'benk.d8.processRun';

/**
 * The global symbol that benk-d8 sets before loading the script in a run of
 * `--processes` that loads head first, to `'head'`
 */
export const D8_FIRST_BUILD = 'benk.d8.firstBuild';

/**
 * The global symbol that benk-d8 sets before loading the script, to the
 * original module arguments paired with their absolute paths. A script can
 * override the arguments or swap the builds. d8 resolves an import from the
 * module that imports it, which is benk's
 */
export const D8_BUILDS = 'benk.d8.builds';
