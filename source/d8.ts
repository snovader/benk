// The entry point of benk for d8, the V8 shell, `benk/d8`, which loads none
// of Node's modules: d8's runtime, and a `bench()` that runs a benchmark
// script with it. A script that measures without `bench()` imports the rest
// from `benk/core`, and passes a `D8Runtime` as the `runtime` option.
export { bench } from './d8/bench.ts';
export { D8Runtime } from './d8/runtime.ts';
export type { BenchOptions } from './core/command-line.ts';
