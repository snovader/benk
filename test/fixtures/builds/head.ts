// A build of the code that the tests of `compareBuilds()` compare: as
// `base.ts`, but its `sum` takes half as long.

/** The build's name, which a test reads to see which build loaded first */
export const NAME = 'head';

export const NANOSECONDS = { sum: 25, sort: 200 };
