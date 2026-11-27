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
 * absolute paths of `--base` and `--head` from its working directory, as an
 * object of `base` and `head`: d8 resolves a relative import from the
 * module that imports it, which is benk's
 */
export const D8_BUILDS = 'benk.d8.builds';
