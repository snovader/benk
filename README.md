# benk

Interleaved benchmarks for JavaScript on Node, built to keep V8's confounds
out of a comparison, or at least in view:

- **Interleaved, rotated rounds.** Every round runs each variant once, in an
  order that rotates so that each variant takes each position, and follows
  each other variant, equally often. Load from other processes, and what one
  variant leaves for the next, then affects every variant alike.
- **An A/A pair in every group.** benk adds a copy of each group's first
  variant, whose ratio to the first is the run's noise floor.
- **Intervals and modes, not just a number.** Each ratio has a 95% interval,
  and a variant whose rounds fall into two clusters, as V8's tiering can make
  them, is flagged rather than averaged.
- **A timer loop per variant.** Each variant is timed by a loop compiled from
  a source of its own, so that variants don't share a call site or type
  feedback.
- **JSON results** with every round's time and position, beside the text
  table, to compare runs later.

It times one process's variants against each other. It isn't a general
harness with every statistic: [mitata](https://github.com/evanwashere/mitata)
and [tinybench](https://github.com/tinylibs/tinybench) cover more ground.

benk has no dependencies, and runs on Node 24 and later.

## Usage

A benchmark is a script that passes groups of variants to `main()`:

```ts
import { main } from 'benk';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

function sumLoop(values: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }
    return sum;
}

await main([
    {
        name: 'sum 1,000 numbers',
        variants: [
            { name: 'for loop', run: () => sumLoop(numbers) },
            { name: 'reduce', run: () => numbers.reduce((sum, x) => sum + x, 0) }
        ]
    }
]);
```

```sh
node bench.ts --rounds 51 --json results.json
```

It prints a description of the run, then each group's table as soon as it's
measured. [`examples/numbers.ts`](examples/numbers.ts) is a complete example,
with a variant that sets up input for each call.

### Options

| Option | Default | |
|---|---|---|
| `--rounds <n>` | 31 | The timed rounds, at least. benk runs whole rotations, so a group of 3 variants and its A/A copy runs 32. |
| `--warmup-rounds <n>` | 10 | Rounds before the timed ones, after which each variant's calls per round are counted again. |
| `--sample-ms <ms>` | 1 | The time of one variant's round. |
| `--filter <regex>` | | Measures only the groups whose name matches. |
| `--json <path>` | | Writes the results as JSON to a file, or to stdout for `-`, when the tables go to stderr. |
| `--no-aa` | | Leaves out the A/A copies. A group's `aa` overrides it. |
| `--no-heap` | | Leaves out the count of heap bytes. |

`measureGroups()` and `measureGroup()` take the same options as an object,
for scripts that print or store results their own way, and return the
results that `main()` writes as JSON.

### Variants

```ts
interface SyncVariant {
    name: string;
    run: () => unknown;
    setup?: (calls: number) => void;
    teardown?: () => void;
}
```

A round calls `run` repeatedly, for about `--sample-ms`. Its last result is
kept alive, so that V8 can't eliminate the calls.

`setup` runs before each loop of calls, untimed, and is given the loop's count
of calls; `teardown` runs after it. A variant whose calls each need fresh
input, such as an array that a call sorts in place, prepares that many
inputs:

```ts
let copies: number[][] = [];
const sortVariant = {
    name: 'sort',
    setup: (calls: number) => {
        copies = Array.from({ length: calls }, () => numbers.slice());
    },
    run: () => copies.pop()!.sort((a, b) => a - b)
};
```

A variant whose calls return promises is marked `async: true`, and a loop of
its own awaits each call before the next. Its `setup` and `teardown` may
return promises too. A sync variant's call that returns a promise is an
error, since the sync loop wouldn't await it.

### Groups

```ts
interface Group {
    name: string;
    variants: Variant[];
    lead?: 'fastest' | 'median' | 'auto';
    aa?: boolean;
}
```

The first variant is the reference, which ratios compare with.

## What the table reports

This is the sorting group of `examples/numbers.ts`, on an Apple M2 Pro with Node
26.13.0:

```
sort 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap
  Float64Array        21.1 µs    23.7 µs    10.4%    1.00×                        0 B
  number[]             121 µs     146 µs    19.8%    6.04×      5.53–6.66   171,516 B
  Float64Array A/A    21.1 µs    23.5 µs     8.9%    1.00×      0.98–1.01         0 B
```

A variant whose rounds form two clusters gets a note below the table, such
as this one from another run of the same example:

```
  number[]: two modes, 18 rounds near 124 µs and 18 near 158 µs
```

Per call of each variant:

- **fastest** and **median**: the fastest round, and the median round. Of an
  even count, the median is the slower of the middle two, so that it's a
  round's time, as in Go's and C++'s harnesses.
- **spread**: the interquartile range of the rounds, as a share of the median.
- **ratio**: the ratio to the reference, by the statistic that the group
  leads with: the fastest round's to the reference's fastest, or the median
  of the ratios of each round's time to the reference's in the same round.
- **95% interval**: a confidence interval of the median of the per-round
  ratios, from their order statistics, which assumes nothing about the
  rounds' distribution. An interval that leaves out 1 says that the variant
  differed from the reference round by round. The A/A row's shows how wide
  an interval is when nothing differs. It's left out with fewer than 6
  rounds.
- **heap**: the bytes that a call allocated on V8's heap, from V8's heap
  statistics and a `GCProfiler`, less what a sample allocates itself. V8
  allocates the contents of an `ArrayBuffer` of more than 64 bytes outside
  its heap, so they're left out. The median of 5 samples counts: compiling
  and deoptimizing allocate in some samples, and in others the heap shrinks
  by more than the collections report, as when V8 sweeps garbage
  concurrently. A call that returns a double, such as a sum, can count 16
  bytes, the size of a boxed number.
- **two modes**: a note for a variant whose rounds form two clusters, far
  apart for their own spread, of at least 3 rounds and 10% each. Its median
  and fastest then describe one of the clusters: compare the modes instead.

### Which statistic leads

A group leads with the **fastest** round when every variant's median call
takes under 1 µs and allocates under 1 KiB, and with the **median**
otherwise, unless it sets `lead`. Every variant of a group is compared by the
same statistic, and the table's title says which, and why.

The rounds of a short call that allocates little differ mostly by load from
other processes and interrupts, which only slow them, so the fastest round
comes closest to the call's own cost, and varies the least. A long call's
round holds few calls, and an allocating call's rounds collect garbage in
some rounds and not in others: their fastest round leaves out work that the
calls cause, which the median includes, and the spread shows how much it
varies.

## JSON results

`--json` writes a `RunResult`, whose types `benk` exports:

```jsonc
{
  "schema": 1,
  "date": "2026-11-19T01:24:00.501Z",
  "runtime": { "name": "Node", "version": "v26.13.0", "engine": "V8 14.6.202.34-node.40",
               "platform": "darwin", "arch": "arm64", "cpu": "Apple M2 Pro", "flags": [] },
  "options": { "rounds": 31, "warmupRounds": 10, "sampleTime": 1, "aa": true, "heap": true, "filter": "" },
  "groups": [{
    "name": "sum 1,000 numbers", "lead": "median", "leadReason": "long calls", "rounds": 32,
    "variants": [{
      "name": "for over number[]", "role": "reference", "async": false, "repetitions": 682,
      "samples": [1465.48, 1468.17, …],   // nanoseconds per call, in the rounds' order
      "positions": [0, 2, 3, 1, …],       // the variant's position in each round
      "summary": { "fastest": …, "q1": …, "median": …, "q3": …, "slowest": …, "spread": …, "modes": null },
      "ratio": 1, "interval": null, "heapBytes": 16
    }]
  }]
}
```

`schema` changes when a field does. The runtime's flags include
`NODE_OPTIONS`, as V8's flags change what's measured.

## The cost of the async loop

The awaiting loop of an async variant costs more per call than the sync
loop, so sync variants keep the sync loop, and a group with both compares
them with that cost included. [`benchmarks/loops.ts`](benchmarks/loops.ts)
calls the same work from each loop. On an Apple M2 Pro with Node 26.13.0, in
3 runs, with a load average near 4 from other processes:

| Work per call | sync loop | async function | resolved promise |
|---|---|---|---|
| a step of a random number generator | 11.6–11.7 ns | 34.8–35.8 ns | 36.5–37.3 ns |
| 400 such steps | 4.52–4.54 µs | 4.53–4.58 µs | 4.58–4.62 µs |

These are the fastest rounds. The await costs about 24 ns a call: three
times the sync loop's time for a call of a few nanoseconds, and within the
A/A pair's noise for a call of a few microseconds.

## Known confounds

benk keeps these in view rather than out of the results:

- **Typed arrays after a detached `ArrayBuffer`.** Once any `ArrayBuffer`
  in the process has been detached, as by `transfer()`, or by growing a
  `WebAssembly.Memory` whose `buffer` was read, V8's optimized code checks
  every typed-array access for a detached buffer. Node's type stripping
  grows its WebAssembly memory when it strips a large enough TypeScript
  file. In one test, a sum of a 1,000-element `Float64Array` took 1.47 µs in
  a plain JavaScript process and 4.5 µs after importing an 8 KB TypeScript
  module, while a `number[]` sum took 1.44 µs in both. So typed-array code
  can time 3× slower when a benchmark, or benk from its source, loads enough
  TypeScript, and faster from a bundle. Compare runs that load code the same
  way.
- **Inlining into the timer loop.** Once V8 optimizes a timer loop, it
  inlines the variant's call into it, which can make the call slower or
  faster than compiled alone: the same sum took 0.80 µs called from a loop
  that didn't inline it, and 1.45 µs inlined. Every variant is timed this
  way, but a function's time in a benchmark can differ from its time in a
  caller that doesn't inline it.

## Runtimes

The core, in `source/core/`, runs on any JavaScript runtime: it times
variants through a `Runtime`, which creates timer loops and counts heap
bytes. `NodeRuntime` creates them with `new Function`, and counts heap bytes
with `node:v8`, which Workers and browsers don't allow. oxlint keeps Node's
modules out of the core. `measureGroup()` and `measureGroups()` take a
`runtime` option, which the tests use with a fake clock and heap.

## Planned

Not built yet:

- **Comparing two revisions.** Build each git revision into a copy of its
  own, load both in one process, and interleave them as variants, with
  position rotation across processes as well as rounds, since V8's tiering
  can favour the first copy that a process loads.
- **A V8 report per hot function.** For each variant's hot functions: their
  bytecode size against TurboFan's inlining budget, what was inlined, and
  deopts, tied to the result that they explain, with a budget check for CI.
- **A `bench` API in hypotes**, Vitest's `bench()` on node:test, layered over
  benk.
- **Runtimes other than Node**: a runtime for browsers and Workers, which
  needs timer loops without `new Function`, such as a loop generated per
  variant at build time, and no heap bytes.
- **Position effects in the report.** The JSON has each round's position;
  the table could flag a variant whose time depends on it.

## Development

Run the checks from the repository's root: `yarn format:check`,
`yarn lint:check`, `yarn typecheck`, `yarn test`, and `yarn test:dist`, which
builds the package and runs the tests on the bundle.
