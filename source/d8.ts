// The entry point of benk's runtime for d8, the V8 shell, `benk/d8`, which
// loads none of Node's modules. A script in d8 imports the rest from
// `benk/core`, and passes a `D8Runtime` as the `runtime` option.
export { D8Runtime } from './d8/runtime.ts';
