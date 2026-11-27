// A build of the code that the tests of `compareBuilds()` compare: what
// each call of the fake runtime takes, in nanoseconds. `head.ts` is the
// same module, whose `sum` takes half as long.

/** The build's name, which a test reads to see which build loaded first */
export const NAME = 'base';

export const NANOSECONDS = { sum: 50, sort: 200 };
