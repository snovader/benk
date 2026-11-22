// A benchmark with a function too large for Turbofan to inline, which
// Turbofan considers inlining in every run, for `--v8-check`'s test of its
// exit code. Whether Turbofan compiles a caller in a run of a few rounds
// depends on V8's tiering, which varies between runs and machines, so this
// has V8 compile `addMix` with Turbofan before `bench()`, with V8's natives
// syntax, which the test runs it with `--allow-natives-syntax` for. It's
// JavaScript, as TypeScript can't parse that syntax.
import { bench } from 'benk';

/** Too large for Turbofan to inline, at more than 460 B of bytecode */
function mix(seed) {
    let h = seed | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    h = Math.imul(h ^ (h >>> 11), 0x1b873593);
    h ^= h >>> 14;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 17), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    h = Math.imul(h ^ (h >>> 11), 0x1b873593);
    h ^= h >>> 14;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 17), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;

    return h >>> 0;
}

/** Calls `mix`, which Turbofan considers inlining into it, and can't */
function addMix(x) {
    return mix(x) + 1;
}

// Feedback of two calls, and then Turbofan's compilation at the third. `mix`
// needs a feedback vector of its own, without which Turbofan doesn't
// consider it, which V8 allocates only after some calls.
%PrepareFunctionForOptimization(mix);
%PrepareFunctionForOptimization(addMix);
addMix(1);
addMix(2);
%OptimizeFunctionOnNextCall(addMix);
addMix(3);

await bench([
    {
        name: 'mix',
        variants: [{ name: 'addMix', run: () => addMix(7) }]
    }
]);
