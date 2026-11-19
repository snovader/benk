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

## Quick start

Install it:

```sh
npm install --save-dev benk
```

A benchmark is a script that passes groups of variants to `main()`. Write
one, as `bench.ts`:

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
            {
                name: 'reduce',
                run: () => numbers.reduce((sum, x) => sum + x, 0)
            }
        ]
    }
]);
```

The script is an ES module, so the project's `package.json` needs
`"type": "module"`, or the script the name `bench.mts`. With
`"type": "commonjs"`, Node rejects the script's `import` statement. Without
a `type`, Node runs it, but warns about it.

Run it:

```sh
node bench.ts
```

```text
Node v26.13.0, V8 14.6.202.34-node.40, darwin arm64, Apple M2 Pro. Process state: entry script from TypeScript source.
Per call, of at least 31 interleaved rounds of 1 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios, and the bytes allocated on the heap.

sum 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap
  for loop            1.41 µs    1.50 µs     3.4%    1.00×                       16 B
  reduce              7.00 µs    7.47 µs     6.6%    4.95×      4.88–5.01    32,040 B
  for loop A/A        1.41 µs    1.50 µs     3.8%    1.00×      0.98–1.00        16 B
```

It prints a description of the run, then each group's table as soon as it's
measured. Here, `reduce` took 4.95 times as long as the loop, and the A/A
copy of the loop, which benk added, took as long as the loop itself.
[What the table reports](#what-the-table-reports) describes each column.

[`examples/numbers.ts`](examples/numbers.ts) is a longer example, with a
variant that sets up input for each call.

## Usage

### Options

A benchmark script takes its options from the command line:

```sh
node bench.ts --rounds 51 --json results.json
```

| Option                | Default | What it does                                                                                                         |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `--rounds <n>`        | 31      | Sets the timed rounds, at least. benk runs whole rotations, so a group of 3 variants and its A/A copy runs 32.       |
| `--warmup-rounds <n>` | 10      | Sets the rounds before the timed ones, after which each variant's calls per round are counted again.                 |
| `--sample-ms <ms>`    | 1       | Sets the time of one variant's round.                                                                                |
| `--filter <regex>`    |         | Measures only the groups whose name matches.                                                                         |
| `--json <path>`       |         | Writes the results as JSON to a file. benk checks that it can write to the file's directory before it measures.      |
| `--json -`            |         | Writes the JSON to stdout, and the tables to stderr.                                                                 |
| `--no-aa`             |         | Leaves out the A/A copies. A group's `aa` overrides it.                                                              |
| `--no-heap`           |         | Leaves out the count of heap bytes.                                                                                  |

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
kept alive, so that V8 can't eliminate the calls. The timer loop calls `run`
as a function of its own, without the variant as `this`, so a method that
reads `this` needs binding, or an arrow function around it.

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
return promises too. The awaiting loop costs more per call, as
[The cost of the async loop](#the-cost-of-the-async-loop) measures. A sync
variant's call that returns a promise is an error, since the sync loop
wouldn't await it.

### Groups

```ts
interface Group {
    name: string;
    variants: Variant[];
    lead?: 'fastest' | 'median' | 'auto';
    aa?: boolean;
}
```

The first variant is the reference, which ratios compare with. `lead` sets
the statistic that they compare, which
[Which statistic leads](#which-statistic-leads) describes. `aa` says whether
the group gets an A/A copy, whatever `--no-aa` says.

A group needs at least one variant, and its variants need different names.
The A/A copy takes the reference's name with ` A/A` after it.

## What the table reports

This is the sorting group of `examples/numbers.ts`, on an Apple M2 Pro with
Node 26.13.0, with benk loaded from its source:

```text
sort 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap
  Float64Array        21.1 µs    23.7 µs    10.4%    1.00×                        0 B
  number[]             121 µs     146 µs    19.8%    6.04×      5.53–6.66   171,516 B
  Float64Array A/A    21.1 µs    23.5 µs     8.9%    1.00×      0.98–1.01         0 B
```

A variant whose rounds form two clusters gets a note below the table, such
as this one from another run of the same example:

```text
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
  rounds. In a group that leads with the fastest round, the ratio compares
  the fastest rounds instead, so the two are different statistics.
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
- **by the fastest rounds, but … round by round**: a note in a group that
  leads with the fastest round, for a variant whose ratio lies more than 5%
  outside its interval, such as
  `f3: 0.24× by the fastest rounds, but 0.46–0.47× round by round`. Its
  rounds then differ from its fastest by more than the reference's do, as
  when its calls collect garbage or run in two modes, which the fastest
  round leaves out: consider `lead: 'median'` for the group. Within 5%, the
  two often differ, the A/A copy's too.

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
               "platform": "darwin", "arch": "arm64", "cpu": "Apple M2 Pro", "flags": [],
               "processState": ["benk from TypeScript source", "entry script from TypeScript source"] },
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
`NODE_OPTIONS`, as V8's flags change what's measured. Its process state is
what benk knows of the process that changes what's measured, as
[Typed arrays and detached buffers](#typed-arrays-and-detached-buffers)
describes.

## API

`benk` exports these, and the types of what they take and return:

| Export                                | What it does                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main(groups, options?)`              | Runs a benchmark script: reads the command line's options, prints the run's description and each group's table, and writes the JSON if asked to. Returns the `RunResult`. |
| `measureGroups(groups, options?)`     | Measures the groups without printing, and returns the `RunResult`.                                                                                                        |
| `measureGroup(group, options?)`       | Measures one group, and returns its `GroupResult`.                                                                                                                        |
| `parseOptions(args)`                  | Reads a script's options from command-line arguments, as `main()` does.                                                                                                   |
| `DEFAULT_OPTIONS`                     | The defaults of `rounds`, `warmupRounds`, `sampleTime`, `aa` and `heap`.                                                                                                  |
| `describeRun(runtime, options)`       | Returns the description that `main()` prints first, from a `RunResult`'s `runtime` and `options`.                                                                         |
| `formatGroup(result)`                 | Returns the lines of a `GroupResult`'s table, with its notes.                                                                                                             |
| `formatJson(value)`                   | Returns results as the JSON that `--json` writes, with each array of numbers on one line.                                                                                 |
| `formatTime(nanoseconds)`             | Returns a time as the table writes it, such as `1.41 µs`.                                                                                                                 |
| `formatBytes(bytes)`                  | Returns a count of bytes as the table writes it, such as `32,040 B`.                                                                                                      |
| `summarize(samples)`                  | Returns the `Summary` of samples: the fastest and slowest, the quartiles, the spread, and two modes if they form two.                                                     |
| `medianInterval(sorted, confidence?)` | Returns a confidence interval of the median of sorted samples, of 95% by default, or `null` for too few samples.                                                          |
| `rotation(count)`                     | Returns the orders of a rotation of `count` variants, each an array of the variants' indexes.                                                                             |
| `chooseLead(lead, variants)`          | Chooses the statistic that a group leads with, and says why.                                                                                                              |
| `NodeRuntime`                         | Times variants in Node. The `runtime` option takes another runtime in its place.                                                                                          |

`measureGroups()` and `measureGroup()` are for scripts that print or store
results their own way. They take their options as an object:

| Option                                 | What it does                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `rounds`, `warmupRounds`, `aa`, `heap` | As `--rounds`, `--warmup-rounds`, `--no-aa` and `--no-heap` on the command line.                   |
| `sampleTime`                           | The time of one variant's round in milliseconds, as `--sample-ms`.                                 |
| `filter`                               | A `RegExp` that selects groups by name. `measureGroups()` only.                                    |
| `onGroup`                              | A function that's called with each `GroupResult` as soon as it's measured. `measureGroups()` only. |
| `runtime`                              | The `Runtime` that times the variants, in place of a `NodeRuntime`.                                |

This script prints each table as `main()` does, and then reads a result:

```ts
import { formatGroup, measureGroups, type Group } from 'benk';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

const groups: Group[] = [
    {
        name: 'sum 1,000 numbers',
        variants: [
            {
                name: 'reduce',
                run: () => numbers.reduce((sum, x) => sum + x, 0)
            }
        ]
    }
];

const result = await measureGroups(groups, {
    rounds: 51,
    onGroup: group => {
        console.log(formatGroup(group).join('\n'));
    }
});

// The median round of the first variant, in nanoseconds per call
console.log(result.groups[0].variants[0].summary.median);
```

`main()` takes other options: `args` in place of the command line's
arguments, `runtime`, and `print` and `write` in place of the console and
stdout.

All three throw:

- a `RangeError` for an option that's out of its range;
- a `TypeError` for a group without variants, or with two of the same name;
- an `Error` if a variant throws, with the variant's error as its `cause`.

### Runtimes

benk runs on Node only. Its measuring isn't particular to Node, though: it
times variants through a `Runtime`, which creates the timer loops and counts
heap bytes. `NodeRuntime` creates the loops with `new Function`, and counts
heap bytes with `node:v8`, which Workers and browsers don't allow. The
`runtime` option takes another `Runtime`, such as one with a fake clock for
a test.

## The cost of the async loop

The awaiting loop of an async variant costs more per call than the sync
loop, so sync variants keep the sync loop, and a group with both compares
them with that cost included. [`benchmarks/loops.ts`](benchmarks/loops.ts)
calls the same work from each loop. On an Apple M2 Pro with Node 26.13.0, in
3 runs, with a load average near 4 from other processes:

| Work per call                       | sync loop    | async function | resolved promise |
| ----------------------------------- | ------------ | -------------- | ---------------- |
| a step of a random number generator | 11.6–11.7 ns | 34.8–35.8 ns   | 36.5–37.3 ns     |
| 400 such steps                      | 4.52–4.54 µs | 4.53–4.58 µs   | 4.58–4.62 µs     |

These are the fastest rounds. The await costs about 24 ns a call: three
times the sync loop's time for a call of a few nanoseconds, and within the
A/A pair's noise for a call of a few microseconds.

## Typed arrays and detached buffers

V8 has had a protector, `ArrayBufferDetaching`, since 2016: until any
`ArrayBuffer` in the process is detached, its optimized code skips checks
for detached buffers, and once one is, it checks for the rest of the
process. `node --trace-protector-invalidation` prints the moment it
happens. Node only triggers it, with operations that detach a buffer. It
slows code that V8 compiled with a typed array as a constant, as when a
variant's call passes the same array every time. A sum of a 1,000-element
`Float64Array` in `examples/numbers.ts`, which does, took 1.41 µs with
benk's bundle, and 4.28 µs with its TypeScript source, whose type stripping
detaches a buffer. Detaching one in a run on the bundle took it to
4.29 µs. These are the fastest rounds of 2 runs each, on an Apple M2 Pro
with Node 26.13.0; a `number[]` sum took 1.41 µs in each. In a plain loop,
the same sum of 2 arrays in turn took 0.84 µs whether a buffer was
detached or not.

**It's a matter of V8's version.** Node 26.13.0's V8, 14.6, switches the
protector off at the first detach. In Node 27.0.0-alpha's V8, 15.6, and in
d8 15.8, no detach did, not even d8's own `%ArrayBufferDetach`, and the
constant sum took 1.40–1.41 µs detached or not. Versions before 14.6, such
as Node 24's, weren't tested, but have the protector, which V8 added in
2016.

In Node 26, these detached a buffer:

- Node's type stripping, when it strips a large enough TypeScript file: an
  8 KB module did, and 2 KB ones didn't;
- reading a `fetch`, `Response` or `Blob` body, or enqueuing into a byte
  stream;
- `transfer()`, and growing a `WebAssembly.Memory` whose `buffer` was read.

These didn't: Node's startup, `fs.readFile`, zlib, `crypto.subtle`,
`Readable.toWeb` of a file stream, and `structuredClone` without a
transfer.

benk detaches none itself. Loaded from its bundle, as it's published, it
leaves the process as the benchmark finds it. Loaded from its TypeScript
source, as in this repository, it doesn't: the run's description and the
JSON's `runtime.processState` then record `'benk from TypeScript source'`.
They record `'entry script from TypeScript source'` when the process's entry
script is TypeScript, as a benchmark that `node bench.ts` runs is, whose
types Node strips the same way, also with benk's bundle. The modules that
the script imports aren't recorded.

To time typed arrays without a detached buffer in Node 26, load the
benchmark and the code that it times from a bundle: in this repository,
`yarn build` writes benk's, and
`node --conditions=benk-dist examples/numbers.ts` runs the example on it.
benk can't see whether other code detached a buffer, as no API reads V8's
protector.

## Known confounds

benk keeps these in view rather than out of the results:

- **Constant inputs.** Once V8 optimizes a timer loop, it inlines the
  variant's call into it, and with it an input that the call passes the
  same every time, as a constant. V8 can then compile the call for that
  input, which can make it slower or faster than with inputs that vary: the
  sum of `examples/numbers.ts` took 1.41 µs over its one constant
  `Float64Array`, and 0.84 µs over 2 arrays in turn, in a plain loop, with
  no buffer detached, in Node 26.13.0. In Node 27.0.0-alpha, 2 arrays in
  turn took 0.99 µs in one run and 1.41 µs in others. A variant that passes
  one of a few inputs in turn times the call more as a caller with varying
  data runs it.

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

[`AGENTS.md`](AGENTS.md) has the guidelines for changing benk, and the checks
to run.

## License

[MIT](LICENSE)
