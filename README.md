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
- **A V8 report of hot functions.** `--v8-report` runs the script again
  with V8's traces, and prints the tiers that V8 compiled each function to,
  what Turbofan inlined, and the deoptimizations, in a bundle's sources
  where it has a source map. It ties each variant's code to its row. The
  command `benk-d8` reports on a script in d8, without the ties.
- **A check for CI.** `--v8-check` fails the run on a hot function too
  large for Turbofan to inline, or on a deoptimization in the timed rounds.

It times one process's variants against each other. It isn't a general
harness with every statistic: [mitata](https://github.com/evanwashere/mitata)
and [tinybench](https://github.com/tinylibs/tinybench) cover more ground.

benk has no dependencies, and runs on Node 24 and later, and in
[d8](#d8), the V8 shell.

## Quick start

Install it:

```sh
npm install --save-dev benk
```

A benchmark is a script that passes groups of variants to `bench()`. Write
one, as `bench.ts`:

```ts
import { bench } from 'benk';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

function sumLoop(values: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }
    return sum;
}

await bench([
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
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios, and the bytes allocated on the heap and in array buffers outside it.

sum 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap     buffers
  for loop            1.41 µs    1.43 µs     5.8%    1.00×                       16 B         0 B
  reduce              6.91 µs    7.19 µs     5.3%    4.96×      4.89–5.09    32,040 B         0 B
  for loop A/A        1.41 µs    1.43 µs     3.5%    1.00×      0.98–1.01        16 B         0 B
```

It prints a description of the run, then each group's table as soon as it's
measured. Here, `reduce` took 4.96 times as long as the loop, and the A/A
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

| Option                      | Default | What it does                                                                                                                     |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--rounds <n>`              | 31      | Sets the timed rounds, at least. benk runs whole rotations, so a group of 3 variants and its A/A copy runs 32.                   |
| `--warmup-rounds <n>`       | 10      | Sets the rounds before the timed ones, after which each variant's calls per round are counted again.                             |
| `--sample-ms <ms>`          | 1       | Sets the time of one variant's round.                                                                                            |
| `--filter <regex>`          |         | Measures only the groups whose name matches.                                                                                     |
| `--json <path>`             |         | Writes the results as JSON to a file. benk checks that it can write to the file's directory before it measures.                  |
| `--json -`                  |         | Writes the JSON to stdout, and the tables to stderr.                                                                             |
| `--no-aa`                   |         | Leaves out the A/A copies. A group's `aa` overrides it.                                                                          |
| `--no-heap`                 |         | Leaves out the counts of bytes allocated, on the heap and in array buffers.                                                      |
| `--v8-report`               |         | Runs the script again with V8's traces, after measuring, and prints [V8's report](#v8s-report) of its hot functions.             |
| `--v8-filter <regex>`       |         | Lists only the functions whose name matches in V8's report, and implies `--v8-report`.                                           |
| `--v8-check`                |         | Checks the functions of V8's report, and exits with 2 if one fails, as [The check](#the-check) describes. Implies `--v8-report`. |
| `--v8-max-bytecode <bytes>` |         | Fails the check for a hot function of more bytecode than this. Implies `--v8-check`.                                             |

A script in d8 takes the same options after `--`, as [d8](#d8) describes.

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
                      fastest     median   spread    ratio   95% interval        heap     buffers
  Float64Array        20.7 µs    22.4 µs     7.4%    1.00×                        0 B         0 B
  number[]             118 µs     132 µs     6.3%    5.79×      5.55–5.97   171,516 B         0 B
  Float64Array A/A    20.3 µs    22.7 µs     5.0%    1.01×      0.99–1.02         0 B         0 B
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
  statistics and a `GCProfiler`, less what a sample allocates itself. The
  median of 5 samples counts: compiling and deoptimizing allocate in some
  samples, and in others the heap shrinks by more than the collections
  report, as when V8 sweeps garbage concurrently. A call that returns a
  double, such as a sum, can count 16 bytes, the size of a boxed number.
- **buffers**: the bytes of array buffers' contents that a call allocated
  outside V8's heap, which **heap** leaves out, as
  [Array buffers outside the heap](#array-buffers-outside-the-heap)
  describes. A call that allocates a `Float64Array` of 128 counts its
  object in **heap**, 200 bytes, and its contents here, 1,024 bytes.
- **–** in **heap** or **buffers**: a count that the run didn't make, as
  with `--no-heap`, or that the runtime can't.
- **median rounds are as short as … times the timer's resolution**: a note
  for a group whose median rounds take less than 50 times the shortest time
  that a timer loop reads, as [JSON results](#json-results) describes it.
  Where the clock is coarse, that time is the clock's tick. A round's time
  is read to a tick, so a ratio can be off by about one over the ticks of a
  round: 2% at 50 ticks, and 10% at 10. The note gives the sample time that
  takes 50, for `--sample-ms`. In Node, the resolution is the time of an
  empty loop, which is longer than the clock's tick, and only rounds of a
  few microseconds get the note, as the sums of `examples/numbers.ts` did
  with `--sample-ms 0.005`:

  ```text
    median rounds are as short as 17 times the timer's resolution, of 125 ns: a sample time of 6.25 µs or more gives 50
  ```
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
takes under 1 µs and allocates under 1 KiB, on the heap and in array buffers
together, and with the **median** otherwise, unless it sets `lead`. Every
variant of a group is compared by the same statistic, and the table's title
says which, and why.

The rounds of a short call that allocates little differ mostly by load from
other processes and interrupts, which only slow them, so the fastest round
comes closest to the call's own cost, and varies the least. A long call's
round holds few calls, and an allocating call's rounds collect garbage in
some rounds and not in others: their fastest round leaves out work that the
calls cause, which the median includes, and the spread shows how much it
varies. A call that allocates a typed array allocates in its buffer, as
[Array buffers outside the heap](#array-buffers-outside-the-heap) measures.

### The collection after the counts

benk counts a group's bytes after its timed rounds, and before the next
group's first call. Each sample has a `GCProfiler` of its own. Node's
`GCProfiler.stop()` returns the statistics, but leaves the profiler's
callbacks registered until V8 collects the profiler. Until then, each of
them reads V8's statistics in every collection. A profiler whose sample saw
two scavenges is in V8's old generation, which only a full collection
collects.

So the counts would slow the next groups' allocating calls, until a full
collection came, in some processes and not in others. After a group's
counts, if a sample saw a collection, benk runs a full collection itself.
When Node exposes `gc()`, benk calls it directly. Otherwise benk requests
an eager memory measurement and waits for the collection in the current
isolate. Node emits an experimental warning on first use of
[`vm.measureMemory()`](https://nodejs.org/api/vm.html#vmmeasurememoryoptions).
`--no-heap` leaves out both the counts and the collection.

On an Apple M2 Pro, with a load average of 4 to 5, 20 processes of each kind
timed four groups of allocating calls, in turn: without the collection,
with a full collection from V8's `gc()`, and with `--no-heap`. The first
variant built 100 small objects in groups 1, 2 and 4, or a string of 200
characters in group 3. These are the medians of the 20 processes' median
rounds of each first variant:

| Node         | Run         | Group 1 | Group 2 | Group 3  | Group 4 |
| ------------ | ----------- | ------- | ------- | -------- | ------- |
| 24.22.3      | without it  | 341 ns  | 726 ns  | 1,438 ns | 344 ns  |
|              | with it     | 340 ns  | 271 ns  | 782 ns   | 277 ns  |
|              | `--no-heap` | 341 ns  | 275 ns  | 775 ns   | 278 ns  |
| 26.13.0      | without it  | 334 ns  | 725 ns  | 1,295 ns | 349 ns  |
|              | with it     | 332 ns  | 296 ns  | 676 ns   | 293 ns  |
|              | `--no-heap` | 334 ns  | 296 ns  | 676 ns   | 293 ns  |
| 27.0.0-alpha | without it  | 319 ns  | 777 ns  | 1,322 ns | 818 ns  |
|              | with it     | 319 ns  | 292 ns  | 671 ns   | 281 ns  |
|              | `--no-heap` | 315 ns  | 287 ns  | 667 ns   | 283 ns  |

Across the 60 processes without a forced collection, groups 2 and 3 gave
120 group measurements. Of those, 119 took more than 1.3 times as long as
with `--no-heap`. Group 4 exceeded that threshold in all 20 Node 27
processes and 3 Node 24 processes. With the collection, none did. Heap
bytes varied by only a few bytes between processes.

A run took 0.80–0.82 s with the collection, 1.09–1.37 s without it, and
0.56–0.57 s with `--no-heap`: the profilers slowed the counts too. The
collection itself paused for 1.2–1.9 ms in these runs, with about 5 MB
alive. It takes longer as more is alive: 17 ms with 73 MB, and 52 ms with
210 MB, in Node 26.13.0.

On the same Apple M2 Pro with Node 26.13.0, a separate run compared ways
to request the collection. Each of four groups built an array of 100 small
objects per call. Across 12 fresh processes per method, the fourth group's
median round took 192 ns per call with eager VM measurement, 190 ns with
V8's `gc()`, 191 ns with `--no-heap`, and 251 ns with an inspector
collection. Releasing the meters took a median of 2.11 ms per group with
eager measurement and 1.64 ms with `gc()`.

## JSON results

`--json` writes a `RunResult`, whose types `benk` exports:

```jsonc
{
  "schema": 4,
  "date": "2026-11-22T12:33:03.133Z",
  "runtime": { "name": "Node", "version": "v26.13.0", "engine": "V8 14.6.202.34-node.40",
               "platform": "darwin", "arch": "arm64", "cpu": "Apple M2 Pro", "flags": [],
               "processState": ["entry script from TypeScript source"] },
  "options": { "rounds": 31, "warmupRounds": 10, "sampleTime": 1, "aa": true, "heap": true, "filter": "^sum" },
  "groups": [{
    "name": "sum 1,000 numbers", "lead": "median", "leadReason": "long calls", "rounds": 32,
    "timerResolution": 166.99999999758575, // nanoseconds: the shortest time that a timer loop read
    "variants": [{
      "name": "for over number[]", "role": "reference", "async": false, "repetitions": 712,
      "samples": [1409.88, 1405.72, …],   // nanoseconds per call, in the rounds' order
      "positions": [0, 2, 3, 1, …],       // the variant's position in each round
      "summary": { "fastest": …, "q1": …, "median": …, "q3": …, "slowest": …, "spread": …, "modes": null },
      "ratio": 1, "interval": null, "heapBytes": 16, "arrayBufferBytes": 0,
      "v8": null                          // what V8 did with its code, with --v8-report
    }]
  }],
  "v8Report": null                        // V8's report, with --v8-report
}
```

`schema` changes when a field does. `v8Report`, and each variant's `v8`,
are V8's report, which `--v8-report` adds, as
[In the results](#in-the-results) describes. They're `null` without it, in
the results of `measureGroups()`, and in d8. The runtime's flags include
`NODE_OPTIONS`, as V8's flags change what's measured. Its process state is
what benk knows of the process that changes what's measured, as
[Typed arrays and detached buffers](#typed-arrays-and-detached-buffers)
describes.

A group's `timerResolution` is the shortest time that a timer loop of the
runtime reads. benk estimates it once for each runtime, before a group's
first calls:

1. It calls an empty function in a timer loop of its own, and doubles the
   calls until a loop reads time.
2. It times 8 loops of half as many calls, which read either no time or one
   tick.
3. It does both twice, and takes the shortest time other than 0 that a loop
   read.

What it gives depends on the clock:

| Clock                                 | `timerResolution`                                   |
| ------------------------------------- | --------------------------------------------------- |
| Coarser than a loop of one empty call | The clock's tick.                                   |
| Finer than that loop, as Node's       | The loop's own time, which is longer than the tick. |
| Reads no time in a loop of 2²⁶ calls  | `null`, and the table has no note.                  |

The last is a clock that only a variant's calls move, as a test's virtual
clock, or a clock that's frozen. Giving up took 61 ms on an Apple M2 Pro
with Node 26.13.0, and 2.1 s with `--jitless`. If a variant's first loops
read no time either, the run throws.

On the same machine, `performance.now()` advances in steps of 41.7 ns. The
first estimates of 61 processes gave 83 ns to 166 ns, and 125 ns in 59 of
them. With `performance.now()` floored to ticks of 1 µs, 5 µs, 20 µs,
100 µs and 1 ms, 500 estimates of each gave the tick, and so did 30 of
16 ms. The median estimate took 4.7 ms for ticks of 1 ms, and 111 ms for
ticks of 16 ms.

## V8's report

`--v8-report` explains a result by what V8 did with the code. After the
tables, benk runs the script again, in a child Node process, with V8's flags
that trace its compilers. It then prints, for each function of the script
that V8 optimized:

- the tiers that V8 compiled it to;
- what Turbofan inlined into it, and where Turbofan inlined it, with the
  sizes of their bytecode;
- its deoptimizations, with their reasons and positions.

Then it prints what V8 did with each variant's code, by the names of the
tables, and Turbofan's limits on inlining. `--v8-check` checks the
functions, for CI, as [The check](#the-check) describes.

```sh
node bench.ts --v8-report --sample-ms 10
```

```text
Node v26.13.0, V8 14.6.202.34-node.40, darwin arm64, Apple M2 Pro. Process state: entry script from TypeScript source.
Per call, of at least 31 interleaved rounds of 10 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios, and the bytes allocated on the heap and in array buffers outside it.

sum 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap     buffers
  for loop             794 ns     806 ns     2.9%    1.00×                       16 B         0 B
  reduce              6.99 µs    7.11 µs     1.0%    8.80×      8.75–8.87    32,040 B         0 B
  for loop A/A         793 ns     806 ns     1.5%    1.00×      0.99–1.01        16 B         0 B
  for loop: two modes, 32 rounds near 805 ns and 4 near 1.45 µs
  for loop A/A: two modes, 32 rounds near 805 ns and 4 near 1.46 µs

V8 report of bench.ts, from a run of it with V8's traces, whose times aren't reported.
Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.
(anonymous) bench.ts:3:46, 15 B of bytecode
  compiled to Maglev
sumLoop bench.ts:5:17, 38 B of bytecode
  compiled to Maglev, Turbofan
  inlined into (anonymous) <anonymous>:1:20 ×2
run bench.ts:17:38, 13 B of bytecode
  compiled to Maglev
  inlined into (anonymous) <anonymous>:1:20 ×2
run bench.ts:20:22, 24 B of bytecode
  compiled to Maglev
(anonymous) bench.ts:20:43, 6 B of bytecode
  compiled to Maglev ×2, Turbofan

By variant, of the tables: where V8 placed its run, the tiers that V8 compiled the run to on its own, and its timer loops that the traces tie to the run, with their tiers, what Turbofan inlined into them, and the deoptimizations of both.
sum 1,000 numbers
  for loop: run bench.ts:17:38, 13 B of bytecode, compiled to Maglev
    2 timer loops, also of for loop A/A, compiled to Maglev ×2, Turbofan ×2
    inlines now node:internal/perf/performance:137:6 (30 B) ×2
    inlines wrappedFn node:internal/errors:542:21 (75 B) ×2
    inlines run bench.ts:17:38 (13 B) ×2
    inlines sumLoop bench.ts:5:17 (38 B) ×2
    inlines (anonymous) node:internal/validators:547:51 (37 B) ×2
  reduce: run bench.ts:20:22, 24 B of bytecode, compiled to Maglev
    no timer loop that the traces tie to its run
  for loop A/A: run bench.ts:17:38, 13 B of bytecode, compiled to Maglev
    2 timer loops, also of for loop, compiled to Maglev ×2, Turbofan ×2
    inlines now node:internal/perf/performance:137:6 (30 B) ×2
    inlines wrappedFn node:internal/errors:542:21 (75 B) ×2
    inlines run bench.ts:17:38 (13 B) ×2
    inlines sumLoop bench.ts:5:17 (38 B) ×2
    inlines (anonymous) node:internal/validators:547:51 (37 B) ×2

Turbofan's limits, from V8's flags: 460 B of bytecode for a function that it inlines, 920 B for the functions that one compilation inlines, in all, and 30 B for a small function, which it inlines beyond that.
```

The tables are of the first run. The report is of the traced run, whose
times it leaves out, as tracing slows it. Here, Turbofan compiled two of
benk's timer loops, and inlined the for loop's `run`, at line 17, and
`sumLoop` into each. A function that `new Function` compiled, as a timer
loop, has no file, and the report writes it as `<anonymous>`, as V8's stack
traces do. The lines by variant say whose loops they are: the for loop's,
and its A/A copy's, which calls the same `run`. No Turbofan compilation of
`reduce`'s loop considered its `run`.

With the default rounds of 1 ms, the same script's report had no line of
inlining, as no Turbofan compilation considered `run` or `sumLoop`, and the
for loop took 1.41 µs rather than 794–799 ns. These are the fastest rounds
of 3 runs of each, on an Apple M2 Pro with Node 26.13.0, with benk's bundle
in another project, and each sample time's 3 reports were the same. The two
modes with 10 ms are the rounds before Turbofan's code: 4 to 6 near 1.45 µs.

A script in d8 gets the same report through the command `benk-d8`, as
[In d8](#in-d8) describes.

### Reading the report

These lines are of the report of this repository's
[`test/fixtures/v8/bench.ts`](test/fixtures/v8/bench.ts), from its directory,
with Node 26.13.0:

| Line                                                                                              | What it says                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sum bench.ts:15:13, 38 B of bytecode`                                                            | The function's name, where it starts, and the size of its bytecode, which Turbofan's limits on inlining count.                 |
| `compiled to Maglev ×3, Turbofan ×3`                                                              | The tiers that V8 compiled it to, and how many times. `(OSR)` marks a compilation of a running loop, by on-stack replacement.  |
| `inlines sum bench.ts:15:13 (38 B) ×2`                                                            | Turbofan inlined `sum` into this function, in 2 of its compilations.                                                           |
| `doesn't inline mix bench.ts:23:13 (874 B): exceeds bytecode limit ×2`                            | Turbofan considered `mix`, and didn't inline it, for V8's reason, when V8 gave one.                                            |
| `inlined into run bench.ts:90:9 ×2`                                                               | The same decisions, in the lines of the function that Turbofan inlined, or didn't, as `not inlined into`.                      |
| `deoptimized in Turbofan's code: wrong map (eager), at bench.ts:17:29, inlined at bench.ts:90:15` | The function's optimized code deoptimized, for V8's reason, at the first position, in a function that was inlined at the next. |

A line that ends in a count, as `×2`, happened that many times, or in that
many compilations. Lines that would be alike, as those of two timer loops,
are counted as one. Turbofan's limits count bytecode. These are V8's
defaults, as `node --v8-options` prints them:

| Flag                                     | What it limits                                        | V8 13.6, Node 24.22.3 | V8 14.6, Node 26.13.0 | V8 15.6, Node 27.0.0-alpha |
| ---------------------------------------- | ----------------------------------------------------- | --------------------- | --------------------- | -------------------------- |
| `--max-inlined-bytecode-size`            | A function that Turbofan inlines                      | 460 B                 | 460 B                 | 460 B                      |
| `--max-inlined-bytecode-size-cumulative` | The functions that one compilation inlines, in all    | 920 B                 | 920 B                 | 920 B                      |
| `--max-inlined-bytecode-size-small`      | A small function, which Turbofan inlines beyond 920 B | 27 B                  | 30 B                  | 30 B                       |

### By variant

After the functions, the report has a part for each group, with lines for
each variant of its table:

| Line                                                                                 | What it says                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `for loop: run bench.ts:17:38, 13 B of bytecode, compiled to Maglev`                 | The variant's `run`: where it starts, the size of its bytecode, and the tiers that V8 compiled it to on its own.                |
| `2 timer loops, also of for loop A/A, compiled to Maglev ×2, Turbofan ×2`            | The timer loops that the traces tie to the `run`, and their tiers. Variants with the same `run` share them.                     |
| `inlines sumLoop bench.ts:5:17 (38 B) ×2`                                            | What Turbofan inlined into those loops, of the script's functions, or didn't, in how many of their compilations.                |
| `loop deoptimized in Maglev's code: wrong map (eager), at … ×2, in the timed rounds` | A deoptimization of a loop's code, or of the `run`'s, and whether it was in the group's timed rounds, or how many of them were. |
| `no timer loop that the traces tie to its run`                                       | No loop was tied to the `run`, as below.                                                                                        |

The traced run is another process. It runs the same script with the same
arguments, so it measures the same groups, with the same variants, in the
same order. After measuring, its `bench()` reads where each variant's `run`
starts, through Node's inspector. That's the position of a function in
V8's log, which ties a timer loop to the variant:

- a loop whose Turbofan compilation considered inlining the `run`;
- a loop whose deoptimization was in the `run`. In
  `at bench.ts:21:32, inlined at bench.ts:92:44, inlined at <anonymous>:6:22`,
  of [The check](#the-check)'s run, the loop's call of `run`, at
  `<anonymous>:6:22`, inlined the `run` that called `sum` at
  `bench.ts:92:44`. That position is in the `run` that starts last before
  it, at `bench.ts:92:38`.

The traces tie nothing else to a loop:

- A loop that only Maglev compiled, and that didn't deoptimize, isn't
  counted, as Maglev's inlining isn't read. With the default rounds of
  1 ms, the quick start's variants had no loop tied to their `run`.
- Loops with the same `run` aren't told apart. A group's reference and its
  A/A copy each count both of their loops.
- A `run` without a position, as a builtin such as `Math.random`, ties
  nothing. A bound function's position is its target's.
- A `run` that starts within another variant's `run` takes the
  deoptimizations of the other's code after its start.

### The check

`--v8-check` checks the functions that the report lists, and fails the run
if one fails:

| Failure                               | What fails                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| over Turbofan's limit                 | A function of the script whose bytecode is over `--max-inlined-bytecode-size`, which a Turbofan compilation considered inlining, and so couldn't. |
| over the limit of `--v8-max-bytecode` | A function of the script whose bytecode is over the limit, which Turbofan compiled, or considered inlining.                                       |
| deoptimized in the timed rounds       | A deoptimization of a listed function's code after its group's warm-up rounds, while its rounds were timed.                                       |

A script's top level isn't checked for its size, as it isn't inlined.
`--v8-filter` selects the functions that it checks, as it selects those that
the report lists. On Windows, it doesn't check for deoptimizations, as the
report can't place the timed rounds among V8's traces there, as
[What the traced run changes](#what-the-traced-run-changes) describes. It
says so in a line after its result.

A run whose check fails exits with 2. A run that throws exits with 1, as
Node exits on an error. `bench()` sets `process.exitCode`, unless the script
has set another code, so the script's code after `bench()` still runs. A CI
step runs it as it is:

```sh
node bench.ts --v8-check
```

Turbofan's limits are V8's flags. They can differ between versions of V8,
and a run can set them. benk reads them with `node --v8-options`, with the
run's flags, which prints each flag's value in the place of its default. With
`--max-inlined-bytecode-size=600`, it printed 600 in Node 24.22.3, 26.13.0
and 27.0.0-alpha. `NODE_OPTIONS` can't set them. A script that sets them as
it runs, with `v8.setFlagsFromString()`, isn't seen. Reading them adds a
process of Node to the run, which took 39 to 55 ms in 5 reads with each of
those versions, on an Apple M2 Pro.

These are the heading and 2 of the 10 failures of the check of a copy of
this repository's [`test/fixtures/v8/bench.ts`](test/fixtures/v8/bench.ts),
with benk's bundle in another project, and Node 26.13.0:

```text
V8 check failed:
  mix bench.ts:29:13, 874 B of bytecode, over Turbofan's 460 B, and considered for inlining into mixAll bench.ts:72:16
  sum bench.ts:19:13 deoptimized in Turbofan's code: wrong map (eager), at bench.ts:21:32, in the timed rounds of sums ×2
```

With `--v8-max-bytecode 40`, the check also failed these:

```text
  mix bench.ts:29:13, 874 B of bytecode, over the limit of 40 B, and considered for inlining into mixAll bench.ts:72:16
  mixAll bench.ts:72:16, 47 B of bytecode, over the limit of 40 B, and compiled by Turbofan
```

In 3 runs of each, on an Apple M2 Pro, the check failed each time. With the
default rounds of 1 ms, `mix` failed, and so did 9 lines of
deoptimizations in the timed rounds. With `--sample-ms 10`, only `mix`
failed: the warm-up rounds took 10 times as long, and none of the
deoptimizations were in the timed rounds. Turbofan considered `mix` for a
timer loop too, which the check writes as `(anonymous) <anonymous>:1:20`.
The lines by variant say whose:
`doesn't inline mix bench.ts:29:13 (874 B): exceeds bytecode limit`, under
the variant `mixed`.

The check sees only what V8 did in the traced run, and V8's tiering can
differ between runs and machines. In CI, on Linux with Node 26.13.0, a run
of `test/fixtures/v8/bench.ts` with 6 rounds of 1 ms passed the check: no
Turbofan compilation considered `mix`. On the Apple M2 Pro, such runs
failed it by `mix`. Longer rounds give V8 the time to compile the code
that calls a function, as `--sample-ms 10` did above.

### In the results

With `--v8-report`, the results have the report too, so `bench()` writes
the JSON after the traced run. If the traced run fails, it writes the
results without the report, and then throws.

| Field                | What it has                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v8Report.script`    | The path of the script that was traced.                                                                                                                                                                                                                           |
| `v8Report.filter`    | The source of `--v8-filter`, or `''`.                                                                                                                                                                                                                             |
| `v8Report.limits`    | Turbofan's limits, as `maxInlinedBytecodeSize`, `maxInlinedBytecodeSizeCumulative` and `maxInlinedBytecodeSizeSmall`, or `null` where `node --v8-options` didn't print them.                                                                                      |
| `v8Report.functions` | The functions that the report lists: each one's `name`, `position` and `bytecodeSize`, its `tiers` and `deoptimizations`, and Turbofan's decisions of its `callees` and `callers`.                                                                                |
| `v8Report.check`     | Whether it `passed`, whether `deoptimizationsChecked`, the `maxBytecodeSize` of `--v8-max-bytecode`, and the `failures`, of the `kind` `'over budget'`, `'over limit'` or `'deoptimized'`. `null` without `--v8-check`.                                           |
| A variant's `v8`     | Its `run`, its `runTiers`, its `loops` and their `loopTiers`, Turbofan's decisions of `inlining` into them, the `deoptimizations` of each `code`, `'run'` or `'loop'`, with how many were `timed`, or `null` on Windows, and the variants that it's `sharedWith`. |

A position has its script's `url`, as V8 names it, and a `line` and a
`column` from 1, in the source that a source map names. A `bytecodeSize` or
a `position` that V8's log hasn't is `null`. A variant's `inlining` has
Node's functions too, such as those of `performance.now()`, which each
timer loop calls, and which the text leaves out.

### Which functions it lists

- The functions of the script, and of the modules that it imports, other
  than Node's and benk's.
- Other functions whose code deoptimized at a position in the script's code,
  such as benk's timer loops, into which V8 inlines a variant's calls.

A function of Node's or benk's that Turbofan inlined into one of the
script's, or didn't, is named in that function's lines.

### Selecting functions

`--v8-filter <regex>` lists only the functions above whose name matches.
It implies `--v8-report`. It's a regular expression, as `--filter` takes,
with the `u` flag, and matches anywhere in the name as the report writes
it. An anonymous function's name is `(anonymous)`, and a script's
top level is `(top level)`. A listed function's lines still name the
functions that it inlined, or was inlined into.

```sh
node bench.ts --sample-ms 10 --v8-filter '^sumLoop$'
```

### Bundles and source maps

A benchmark can time a bundle, as the code is deployed, rather than its
sources. V8 places the bundle's functions in the bundle, which a build may
delete after the run. Where the bundle has a source map, the report places
them in the sources instead.

1. Write the function that the benchmark times in a module of its own, as
   `sum.ts`:

   ```ts
   export function sumLoop(values: readonly number[]): number {
       let sum = 0;
       for (let i = 0; i < values.length; i++) {
           sum += values[i];
       }
       return sum;
   }
   ```

2. Import it in the benchmark, `bench.ts`:

   ```ts
   import { bench } from 'benk';
   import { sumLoop } from './sum.ts';

   const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

   await bench([
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

3. Bundle it with a source map, here with
   [rolldown](https://rolldown.rs), which writes `dist/bench.mjs` and
   `dist/bench.mjs.map`. benk stays an import:

   ```sh
   npx rolldown bench.ts --file dist/bench.mjs --sourcemap --external benk --platform node
   ```

4. Run the bundle:

   ```sh
   node dist/bench.mjs --sample-ms 10 --v8-filter sumLoop
   ```

   After the tables, it prints:

   ```text
   V8 report of dist/bench.mjs, from a run of it with V8's traces, whose times aren't reported.
   Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.
   Only the functions whose names match sumLoop.
   sumLoop sum.ts:1:24, 38 B of bytecode
     compiled to Maglev, Turbofan
     inlined into (anonymous) <anonymous>:1:20 ×2
   ```

`sumLoop` is at `sum.ts:1:24`, its parameters, where V8 places a function.
In the bundle, it's at `dist/bench.mjs:3:17`. These are of 3 runs on an
Apple M2 Pro with Node 26.13.0 and rolldown 1.3.2, whose reports were the
same.

- benk reads the source map of each script that the traces place a
  function or a deoptimization in. That's the file that the script's last
  `//# sourceMappingURL=` comment names, beside the script, or the map
  inline, as a `data:` URL.
- The comment has to start its line, as bundlers write it. That tells it
  from the same text in a string, which V8 doesn't read either. A comment
  after code on its line, which V8 reads, isn't read.
- The traced run reads them, before its own `bench()` returns. It runs all
  of the script, so a script that deletes its bundle after `bench()`
  deletes it in the traced run too, before benk prints the report. A script
  that bundled `bench.ts`, imported the bundle and then deleted it still
  had `sumLoop` at `sum.ts:1:24`.
- Node's [`SourceMap`](https://nodejs.org/api/module.html#class-modulesourcemap)
  reads each map. A column after the start of a mapping is as far after
  the start in the source, as Node's `findOrigin()` takes it.
- A position before the first mapping of its line stays the bundle's, as
  in code that the bundler wrote.
- The names are V8's, as the bundle has them. A bundler can rename a
  function, as rolldown renames a second `sum` to `sum$1`, and
  `--v8-filter` matches the bundle's name.
- A column after a renamed name, or in minified code, is approximate. It's
  off by what the bundler changed between the mapping and the position.
  With `a.ts` and `b.ts`, which each export a `sum`, rolldown renamed
  `a.ts`'s to `sum$1`. The report placed it at `a.ts:1:22`, 2 columns
  after its parameters, as `sum$1` is 2 characters longer. With
  `--minify`, it was `t a.ts:1:18`, and each variant's `run` was 1 column
  before its parameters. Their lines were right.

A script that names a source map that can't be read keeps its own
positions. The report then says why, after its heading, for each such
script that it places a function or a deoptimization in. With the map
deleted, the same run printed:

```text
Positions in dist/bench.mjs are its own: its source map, bench.mjs.map, couldn't be read (ENOENT).
sumLoop dist/bench.mjs:3:17, 38 B of bytecode
```

A script that names no source map, as a TypeScript file that Node runs as
it is, has its own positions, without a note.

A hook that rewrites a module without a source map moves its positions.
V8 compiles the hook's output, so the report has that output's lines. With
[`@snovader/node-hooks`](https://www.npmjs.com/package/@snovader/node-hooks),
whose output has fewer lines than the source, the report placed a function
at line 15 that the file has at line 19. Node's own stripping keeps each
line, and placed it at line 19. That was
[`test/fixtures/v8/bench.ts`](test/fixtures/v8/bench.ts) on Node 26.13.0.

### In d8

[d8](#d8), V8's shell, can have a newer V8 than Node's, which compresses
pointers, as workerd's and Chrome's do. Its report shows what that V8 does
with the code. d8 can't start a process, so its `bench()` can't run the
script again, and `--v8-report` is an error there. `benk-d8`, the
package's command, runs the script in d8 from Node instead. It takes d8's
command line:

| Argument       | What it is                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| `--d8=<path>`  | d8's binary. Without it, `d8` on the PATH.                                            |
| d8's flags     | Passed to d8 before the script, in both runs. A flag with a value takes it after `=`. |
| `<script>`     | The script: an ES module that calls `benk/d8`'s `bench()`, as d8 runs it.             |
| `-- <options>` | The script's [options](#options), after `--`, as d8 passes a script its arguments.    |

1. Write the script, `bench.mjs`, as [d8](#d8) shows.

2. Run it with `npx benk-d8` in place of `d8`:

   ```sh
   npx benk-d8 bench.mjs -- --sample-ms 10 --v8-report
   ```

   ```text
   d8 15.8.62.9, V8 15.8.62.9, macos unknown, unknown, with unknown. Process state: 31-bit small integers.
   Per call, of at least 31 interleaved rounds of 10 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
   the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios.

   sum 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                         fastest     median   spread    ratio   95% interval        heap     buffers
     for loop             791 ns     809 ns     2.5%    1.00×                          –           –
     reduce              6.35 µs    6.49 µs     1.5%    8.03×      7.89–8.07           –           –
     for loop A/A         790 ns     811 ns     2.2%    1.01×      1.00–1.01           –           –
     for loop: two modes, 31 rounds near 806 ns and 5 near 1.44 µs
     for loop A/A: two modes, 31 rounds near 810 ns and 5 near 1.44 µs

   V8 report of bench.mjs, from a run of it in d8 15.8.62.9 with V8's traces, whose times aren't reported.
   Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.
   (anonymous) bench.mjs:3:46, 15 B of bytecode
     compiled to Maglev
   sumLoop bench.mjs:5:17, 37 B of bytecode
     compiled to Maglev, Turbofan
     inlined into (anonymous) <anonymous>:1:20 ×2
   run bench.mjs:17:38, 11 B of bytecode
     compiled to Maglev
     inlined into (anonymous) <anonymous>:1:20 ×2
   run bench.mjs:20:22, 22 B of bytecode
     compiled to Maglev
   (anonymous) bench.mjs:20:43, 6 B of bytecode
     compiled to Maglev ×2, Turbofan
   ```

benk-d8 runs the script in d8 first, as `d8 bench.mjs -- --sample-ms 10`
would, and that run prints the tables. It then runs the script again in d8,
with V8's trace flags, and prints the report, whose heading names d8's
version. Here, as in Node, Turbofan inlined the for loop's `run` and
`sumLoop` into two timer loops. These are of 3 runs on an Apple M2 Pro,
with Homebrew's d8 15.8.62.9, whose reports were the same. With the
default rounds of 1 ms, the report had no line of inlining in 3 runs, and
the for loop's fastest round took 1.41 to 1.49 µs, against 790 or 791 ns
with 10 ms.

- The first run gets the script's options but `--v8-report` and
  `--v8-filter`, which benk-d8 carries out. The traced run gets none of
  those, nor `--json`, so it writes no results.
- A script in d8 can't read the environment, so the traced run can't tell
  that it's traced. It prints its tables among the traces, which the
  report skips.
- A bundle's source map places its positions, as in Node. A TypeScript
  `bench.ts` that imported `bench` from `benk/d8` and `sumLoop` from
  `./sum.ts`, bundled by rolldown 1.3.2 with
  `rolldown bench.ts --file dist/bench.mjs --sourcemap`, had `sumLoop` at
  `sum.ts:1:24`, as in Node, in 3 runs.
- d8 has no inspector, so benk-d8 reads the source maps after the traced
  run, rather than before its `bench()` returns.
- The report has no lines by variant, and `--v8-check` and
  `--v8-max-bytecode` are errors, before benk-d8 runs d8. Both need
  Node's traced run: d8 has no inspector to read where a variant's `run`
  starts, and its `bench()` can't tell that it's traced, to mark the timed
  rounds.
- The report tells benk's functions by their files: those of benk's
  bundle, which a script imports from `node_modules/benk/dist`, or which a
  bundle's source map names. A bundle that has benk in it, without a
  source map, can't tell them from the script's.

d8 counts array buffers only with the three flags of
[Bytes in d8](#bytes-in-d8), so **buffers** shows `–` without them.
benk-d8 doesn't add them. They change the flags of the timed run, and the
count takes time before each sample. Give them before the script, as any
of d8's flags, and both runs get them. This runs `copy.mjs`, of
[Bytes in d8](#bytes-in-d8):

```sh
npx benk-d8 --expose-statistics --expose-gc --allow-natives-syntax copy.mjs -- --v8-report
```

```text
d8 15.8.62.9, V8 15.8.62.9, macos unknown, unknown, with --allow-natives-syntax --expose-gc --expose-statistics unknown. Process state: 31-bit small integers.
Per call, of at least 31 interleaved rounds of 1 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios, and the bytes allocated on the heap and in array buffers outside it.

copy 1,000 numbers: 36 rounds, by the median round (a call allocating 1 KiB or more)
                       fastest     median   spread    ratio   95% interval        heap     buffers
  slice                 188 ns     207 ns    34.6%    1.00×                          –         0 B
  Float64Array.from     693 ns     923 ns    26.4%    4.30×      3.83–4.56           –     8,000 B
  slice A/A             187 ns     253 ns    29.6%    1.03×      0.99–1.24           –         0 B

V8 report of copy.mjs, from a run of it in d8 15.8.62.9 with V8's traces, whose times aren't reported.
Per function of the script, and per function that deoptimized in the script's code: the tiers that V8 compiled it to, what Turbofan inlined into it and where it inlined it, with sizes of bytecode, and its deoptimizations.
(anonymous) copy.mjs:3:46, 15 B of bytecode
  compiled to Maglev
run copy.mjs:9:35, 13 B of bytecode
  compiled to Maglev
  inlined into (anonymous) <anonymous>:1:20 ×2
run copy.mjs:10:47, 18 B of bytecode
  compiled to Maglev
```

This is one of 3 runs on an Apple M2 Pro, with Homebrew's d8 15.8.62.9 and
a load average near 4. Each led with the median round, and the ratios of
`Float64Array.from` were 4.58, 4.30 and 3.95. In 3 runs without the flags,
**buffers** showed `–`, and the group led with the fastest round. The
report was the same in all 6 runs.

When a step fails, benk-d8 prints an error, rather than an empty report:

| What fails                                                              | What benk-d8 does                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No `d8` on the PATH, or at the path of `--d8`                           | Says how to install d8, and exits with 1.                                                        |
| The command line, or the script's options                               | Says what's wrong, as `bench()` would, before d8 runs, and exits with 1.                         |
| The script, in the first run                                            | d8 prints the error. benk-d8 exits with d8's code, without the traced run.                       |
| d8 warns that it doesn't know a trace flag, as an older d8 may          | Names the flag, and exits with 1, rather than report without its lines.                          |
| The traced run exits with another code than 0                           | Prints d8's stderr and the last lines of its stdout, where d8 writes an error, and exits with 1. |
| The traced run writes no code log, or none of the lines that benk reads | Says which, and exits with 1.                                                                    |

What the report can't show in d8:

- What workerd or a browser does with the code. Their V8 can be d8's
  version, but they run it with flags, snapshots and APIs of their own.
- What the report leaves out in Node, as
  [What it leaves out](#what-it-leaves-out) lists.

### What the traced run changes

1. It runs the script with the same arguments. benk sets `BENK_TRACED_RUN`
   in its environment, where `bench()` measures as it does otherwise, so
   that V8 sees the same calls, but prints nothing and writes no JSON. A
   script that does more, such as writing files, does it twice.
2. Its `bench()` writes a line to stdout, among V8's traces, as each call
   of it starts and ends measuring, and as each group's timed rounds start
   and end. The report cuts the lines out of the traces, wherever they
   fall.
   - On macOS and Linux, Node turns off the C runtime's buffering of
     stdout, which V8 prints its traces through. V8 writes them while
     JavaScript waits, so such a line falls between two of V8's. Of 300
     functions made hot between two such lines, each of the 1,050
     compilations and deoptimizations fell between the right two, in Node
     24.22.3, 26.13.0 and 27.0.0-alpha on macOS. Once, in CI on Linux with
     Node 24.22.3, a line fell within one of V8's. None did in 22 traced
     runs since, on macOS and on Linux arm64 in Docker, nor in 32 on Linux
     x64 in Docker, where V8 ran without Turbofan, as it does under the
     Mac's emulation of x64. The report places such a line at the start of
     the line of V8's that it fell within.
   - On Windows, Node leaves the buffering on, as `src/node.cc` turns it
     off for POSIX only. V8's lines reach stdout in chunks of the buffer,
     and a line of benk's falls between two chunks, before lines of V8's
     that came before it, and often within one. The report then places no
     trace by the lines: a variant's `timed` is `null`, and the check
     doesn't check for deoptimizations, and says so. With several calls of
     `bench()`, each call's variants are tied to the loops of all of them.
3. Once it has measured, its `bench()` reads where each variant's `run`
   starts, and the source maps of the scripts that V8 has compiled, for the
   report. It reads them through Node's
   [inspector](https://nodejs.org/api/inspector.html), whose debugger it
   enables only for that, as V8 on Windows keeps its code log to itself
   until the run exits. In 3 runs of a script that bundled its benchmark
   with rolldown, on an Apple M2 Pro with each of Node 24.22.3, 26.13.0 and
   27.0.0-alpha, reading the source maps took 32 to 39 ms, for 202 or 203
   scripts. The reports of a script that calls `bench()` twice were the
   same with it and without it, but for a timer loop whose tiers differed
   between runs either way. A Node built without the inspector reads the
   source maps after the run instead, so a deleted bundle keeps its own
   positions, and has no position of a `run`, which ties nothing.
4. Reading the positions of 5 functions took 24 to 42 ms the first time in
   a process, and about 3 ms after it, with the same versions. Of 9 runs of
   another script that calls `bench()` twice, with `--sample-ms 2` and Node
   26.13.0, 8 reports were alike with the positions read, and 5 of 9
   without. The others differed by a Turbofan compilation of a timer loop,
   or its inlining, either way.
5. V8's flags are `--trace-opt`, `--trace-deopt-verbose` and
   `--trace-turbo-inlining`, whose traces go to the run's stdout, and
   `--log-code` with `--no-logfile-per-isolate`, whose log of each
   function's position and bytecode benk reads from a temporary file. The
   run writes to the first run's stderr.
6. `--no-concurrent-recompilation` compiles on the main thread, so that a
   compilation's lines come together. In Node 27.0.0-alpha, a background
   compilation's line of inlining was split by another line. V8 then
   installs optimized code as soon as it's compiled, rather than when the
   main thread next checks for it.
7. It's another process, so V8's decisions can differ from the first run's,
   as its calls per round can.

### What it leaves out

- Maglev's inlining. `--trace-maglev-inlining` printed another format in
  each of V8 13.6, 14.6 and 15.6, and V8 15.6 colours it. Maglev inlines
  too: a deoptimization of Maglev's code
  `at bench.ts:17:29, inlined at bench.ts:80:15, inlined at <anonymous>:6:22`
  was in `sum`, inlined into a variant's `run`, inlined into its timer loop.
- Sparkplug's compilations, which `--trace-opt` doesn't print.
- A timer loop that the traces don't tie to its variant, as
  [By variant](#by-variant) describes.
- Where the timed rounds were among V8's traces, on Windows, as
  [What the traced run changes](#what-the-traced-run-changes) describes.
- In d8, the lines by variant and the check, as [In d8](#in-d8) describes.

V8 doesn't keep the traces' formats stable. The parsers were checked
against what Node 24.22.3, 26.13.0 and 27.0.0-alpha and d8 15.8.62.9
wrote on macOS, and against the same with addresses as Windows prints some
of them, without `0x`. d8 15.8 wrote the formats of Node 27.0.0-alpha's
V8 15.6, but named a script by its path. If the traced run's stdout has
none of V8's compilations, or its log none of its functions,
`--v8-report` throws, rather than print an empty report.

## API

`benk` exports these, and the types of what they take and return:

| Export                                | What it does                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench(groups, options?)`             | Runs a benchmark script: reads the command line's options, prints the run's description and each group's table, and writes the JSON if asked to. Returns the `RunResult`. |
| `measureGroups(groups, options?)`     | Measures the groups without printing, and returns the `RunResult`.                                                                                                        |
| `measureGroup(group, options?)`       | Measures one group, and returns its `GroupResult`.                                                                                                                        |
| `parseOptions(args)`                  | Reads a script's options from command-line arguments, as `bench()` does.                                                                                                  |
| `DEFAULT_OPTIONS`                     | The defaults of `rounds`, `warmupRounds`, `sampleTime`, `aa` and `heap`.                                                                                                  |
| `describeRun(runtime, options)`       | Returns the description that `bench()` prints first, from a `RunResult`'s `runtime` and `options`.                                                                        |
| `formatGroup(result)`                 | Returns the lines of a `GroupResult`'s table, with its notes.                                                                                                             |
| `formatJson(value)`                   | Returns results as the JSON that `--json` writes, with each array of numbers on one line.                                                                                 |
| `formatTime(nanoseconds)`             | Returns a time as the table writes it, such as `1.41 µs`.                                                                                                                 |
| `formatBytes(bytes)`                  | Returns a count of bytes as the table writes it, such as `32,040 B`.                                                                                                      |
| `summarize(samples)`                  | Returns the `Summary` of samples: the fastest and slowest, the quartiles, the spread, and two modes if they form two.                                                     |
| `medianInterval(sorted, confidence?)` | Returns a confidence interval of the median of sorted samples, of 95% by default, or `null` for too few samples.                                                          |
| `rotation(count)`                     | Returns the orders of a rotation of `count` variants, each an array of the variants' indexes.                                                                             |
| `chooseLead(lead, variants)`          | Chooses the statistic that a group leads with, and says why.                                                                                                              |
| `timerSource(id)`                     | Returns the body of benk's timer loop, for a runtime that can't compile one, as [Runtimes](#runtimes) describes.                                                          |
| `asyncTimerSource(id)`                | Returns the body of the timer loop that awaits each call.                                                                                                                 |
| `NodeRuntime`                         | Times variants in Node. The `runtime` option takes another runtime in its place.                                                                                          |

`measureGroups()` and `measureGroup()` are for scripts that print or store
results their own way. They take their options as an object:

| Option                                 | What it does                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rounds`, `warmupRounds`, `aa`, `heap` | As `--rounds`, `--warmup-rounds`, `--no-aa` and `--no-heap` on the command line.                                                                    |
| `sampleTime`                           | The time of one variant's round in milliseconds, as `--sample-ms`.                                                                                  |
| `filter`                               | A `RegExp` that selects groups by name. `measureGroups()` only.                                                                                     |
| `onGroup`                              | A function that's called with each `GroupResult` as soon as it's measured. `measureGroups()` only.                                                  |
| `onRounds`                             | A function that's called with each `Group` before its first timed round, with `'timed'`, and after its last, with `'done'`. `measureGroups()` only. |
| `runtime`                              | The `Runtime` that times the variants, in place of a `NodeRuntime`.                                                                                 |

This script prints each table as `bench()` does, and then reads a result:

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

`bench()` takes other options: `args` in place of the command line's
arguments, `runtime`, and `print` and `write` in place of the console and
stdout.

All three throw:

- a `RangeError` for an option that's out of its range;
- a `TypeError` for a group without variants, or with two of the same name;
- an `Error` if the runtime's clock reads no time, neither for empty calls
  nor in a loop of 2²⁰ of a variant's calls;
- an `Error` if a variant throws, with the variant's error as its `cause`.

### Runtimes

benk's measuring isn't particular to Node. It times variants through a
`Runtime`, which creates the timer loops and counts the bytes that calls
allocate. `NodeRuntime` creates the loops with `new Function`, and counts
heap bytes with `node:v8`, which Workers and browsers don't allow. It counts
array buffers' bytes with `process.memoryUsage()`. A runtime without
`arrayBuffers` counts none, as the runtime below. The `runtime` option takes
another `Runtime`, such as one with a fake clock for a test.

A meter can have a `release()` method to undo what its counts left in the
process. benk stops each sample even if a variant throws. After the counts,
it releases both meters and awaits their releases before reporting the
group. A single failure rejects the measurement with that error. Multiple
count and release failures produce an `AggregateError` whose `errors` are
in occurrence order and whose `cause` is the first error. Node's meters run
a full collection when a sample saw a collection, as
[The collection after the counts](#the-collection-after-the-counts)
describes.

benk has runtimes for Node, and for d8, as [d8](#d8) describes. A script
for another runtime passes its own, and imports `benk/core` rather than
`benk`. Importing `benk` loads Node's modules, whichever runtime times the
variants. Importing `benk/core` loads none.

`benk/core` exports what `benk` does, except these, which need Node:

| Export        | What to do without it                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bench()`     | Call `measureGroups()`, and print with `describeRun()` and `formatGroup()`. In d8, import `bench()` of `benk/d8`. |
| `NodeRuntime` | Pass a `Runtime` as the `runtime` option, which `benk/core` requires.                                             |

A runtime that can't compile a string needs its loops written before it
runs. Each variant needs a loop from a source of its own: V8 shares the
compiled code and type feedback of identical sources, and of closures of
one function.

- `timerSource(id)` returns the body of benk's loop, for a function that
  takes `run` and `repetitions`.
- `asyncTimerSource(id)` returns the body of the loop that awaits each
  call, for an async function.
- Each `id` gives another source.
- The body ends with a comment, so the function's closing brace goes on a
  line after it.

A group needs a loop for each variant, and one for its A/A copy. A runtime
needs one more, the first time that it measures a group, to time its clock,
which benk takes before the group's own.
This script, `write-timers.ts`, writes a module of 16 loops:

```ts
import { writeFileSync } from 'node:fs';
import { timerSource } from 'benk/core';

const loops = Array.from(
    { length: 16 },
    (_, id) => `function (run, repetitions) {\n${timerSource(id)}\n}`
);

writeFileSync(
    'timers.ts',
    `// @ts-nocheck
import type { Timer } from 'benk/core';

export const timers: Timer[] = [
${loops.join(',\n')}
];
`
);
```

Run it with `node write-timers.ts`. This script, `bench.ts`, then times a
group with those loops, and prints its table:

```ts
import { formatGroup, measureGroups, type Runtime } from 'benk/core';
import { timers } from './timers.ts';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

const runtime: Runtime = {
    description: {
        name: 'My runtime',
        version: 'unknown',
        engine: 'unknown',
        platform: 'unknown',
        arch: 'unknown',
        cpu: 'unknown',
        flags: [],
        processState: []
    },
    createTimer() {
        const timer = timers.pop();
        if (timer === undefined) {
            throw new Error('Expected timers.ts to have a loop for each variant');
        }

        return timer;
    },
    createAsyncTimer() {
        throw new Error('Expected sync variants only');
    },
    heap: undefined
};

await measureGroups(
    [
        {
            name: 'sum 1,000 numbers',
            variants: [
                {
                    name: 'reduce',
                    run: () => numbers.reduce((sum, x) => sum + x, 0)
                }
            ]
        }
    ],
    {
        runtime,
        onGroup: group => {
            console.log(formatGroup(group).join('\n'));
        }
    }
);
```

Both scripts were run in Node. benk isn't tested in a Worker or a browser,
whose clocks and module loading differ from Node's.

### d8

[d8](https://v8.dev/docs/d8) is V8's own shell, which runs JavaScript
without Node. Its V8 can be newer than Node's, or built otherwise. Homebrew's
d8 15.8.62.9, from `brew install v8`, has small integers of 31 bits, as
V8's builds with [pointer compression](https://v8.dev/blog/pointer-compression)
do, and Node 26.13.0 has small integers of 32 bits.

`benk/d8` exports d8's `bench()` and runtime, and loads none of Node's
modules:

| Export                    | What it does                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench(groups, options?)` | Runs a benchmark script in d8, as `benk`'s `bench()` does in Node, with the options that d8 can carry out.                                     |
| `D8Runtime`               | Times variants in d8, each in a timer loop that `new Function` compiles, as in Node, and with three of d8's flags counts array buffers' bytes. |

d8 reads an import as a path, not as a package's name. So a script imports
benk's bundle from `node_modules`, as this one, `bench.mjs`, does:

```js
import { bench } from './node_modules/benk/dist/d8.js';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

function sumLoop(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }
    return sum;
}

await bench([
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

d8 runs a `.mjs` file as an ES module, and passes the script the arguments
after `--`:

```sh
d8 bench.mjs -- --rounds 51 --json results.json
```

```text
d8 15.8.62.9, V8 15.8.62.9, macos unknown, unknown, with unknown. Process state: 31-bit small integers.
Per call, of at least 51 interleaved rounds of 1 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios.

sum 1,000 numbers: 54 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap     buffers
  for loop            1.41 µs    1.45 µs     3.7%    1.00×                          –           –
  reduce              6.21 µs    6.45 µs     4.2%    4.46×      4.42–4.51           –           –
  for loop A/A        1.41 µs    1.46 µs     5.1%    1.00×      0.99–1.01           –           –
```

This is one of 3 runs on an Apple M2 Pro, with Homebrew's d8 15.8.62.9,
whose ratios of `reduce` were 4.46, 4.46 and 4.49. Each wrote its results
to `results.json`. Without `--`, d8 takes the options for its own flags. It
warns of an unknown flag, runs the script with benk's defaults, and then
fails to load a value, such as `51`, as another script.

#### Options in d8

| Option                                                              | In d8                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--rounds`, `--warmup-rounds`, `--sample-ms`, `--filter`, `--no-aa` | As in Node.                                                                                                                                                                   |
| `--json <path>`                                                     | Writes the file with d8's `writeFile()`. benk checks the path by writing the file before it measures, as d8 can't check a directory.                                          |
| `--json -`                                                          | Writes the JSON to stdout with d8's `write()`, and the tables to stderr with `printErr()`.                                                                                    |
| `--no-heap`                                                         | Turns off the count of array buffers, where d8 counts them, as [Bytes in d8](#bytes-in-d8) describes. Otherwise it changes nothing.                                           |
| `--v8-report`, `--v8-filter`                                        | Throws before it measures, as d8 can't run the script again. [`benk-d8`](#in-d8) runs the script in d8 from Node, and carries them out.                                       |
| `--v8-check`, `--v8-max-bytecode`                                   | Throws before it measures, and so does `benk-d8`: [The check](#the-check) needs Node's traced run, which reads where each variant's `run` starts, and marks the timed rounds. |

To check the path of `--json`, benk writes the file again with the bytes
that d8 reads of it, or empty where there's none. So a run that fails leaves
an earlier file as it was, as in Node, and an empty file where there was
none.

What a run in d8 reports differs from Node's:

- **heap** shows `–`, and `heapBytes` is null. **buffers** shows `–` too,
  and `arrayBufferBytes` is null, unless d8 started with the three flags of
  [Bytes in d8](#bytes-in-d8). Where it counts neither, `bench()` records
  `heap: false`, so the description leaves the bytes out. A script that
  calls `measureGroups()` with a `D8Runtime` records its `heap` option,
  which is on by default, and its description lists the bytes anyway.
- **The runtime's description** gives `unknown` for the architecture, the
  processor and the flags that d8 started with, which d8 can't read. Where
  it counts array buffers, the flags are the three that the count needs,
  and `unknown` for any others. The platform is d8's name for the operating
  system, such as `macos`, where Node's is `darwin`.
- **The process state** records the bits of the small integers. d8 has no
  property that says, but its serializer writes 2³⁰ as an integer where they
  have 32 bits, and as a double where they have 31. With 31, integers from
  2³⁰ to 2³¹ − 1 are numbers on the heap.
- **The timer's resolution**: d8's `performance.now()` advances in steps of
  1 µs, which benk's estimate gives. A round of the default 1 ms spans 1,000
  of them. Median rounds under 50 µs get the note.

d8's `bench()` takes the options that `benk`'s does, as [API](#api) lists
them. Their defaults are d8's: its `arguments`, a `D8Runtime`, and its
`print()`, `printErr()` and `write()`. A script that prints or stores
results its own way imports `measureGroups()` from `benk/core`, and passes
a `D8Runtime` as the `runtime` option, as in [Runtimes](#runtimes).

A TypeScript script, or one that imports `benk/d8` by name, as in Node,
needs bundling into one module first. A `bench.ts` that did so ran as
`bench.mjs` did, bundled by rolldown 1.3.2:

```sh
rolldown bench.ts --file bench.mjs
```

#### Bytes in d8

d8 counts no heap bytes. A collection during a sample frees bytes, which
Node's runtime adds back from a `GCProfiler`. d8 has nothing that reports
what a collection freed. V8's statistics give the heap's used bytes, which
fall at each scavenge. In d8 15.8.62.9, calls that each allocated an object
of 20 bytes counted 20.15 bytes a call in samples of 10,000 calls, and
−78.13 in one during which a scavenge ran. Samples of 100,000 calls or
more, each with scavenges, counted from −0.62 to 0.12.

d8 counts array buffers' bytes when it starts with three of its flags. This
script, `copy.mjs`, copies an array, on the heap and into a typed array:

```js
import { bench } from './node_modules/benk/dist/d8.js';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

await bench([
    {
        name: 'copy 1,000 numbers',
        variants: [
            { name: 'slice', run: () => numbers.slice() },
            { name: 'Float64Array.from', run: () => Float64Array.from(numbers) }
        ]
    }
]);
```

Run it with the flags before the script:

```sh
d8 --expose-statistics --expose-gc --allow-natives-syntax copy.mjs
```

```text
d8 15.8.62.9, V8 15.8.62.9, macos unknown, unknown, with --allow-natives-syntax --expose-gc --expose-statistics unknown. Process state: 31-bit small integers.
Per call, of at least 31 interleaved rounds of 1 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios, and the bytes allocated on the heap and in array buffers outside it.

copy 1,000 numbers: 36 rounds, by the median round (a call allocating 1 KiB or more)
                       fastest     median   spread    ratio   95% interval        heap     buffers
  slice                 171 ns     199 ns    24.5%    1.00×                          –         0 B
  Float64Array.from     652 ns     790 ns    37.4%    3.90×      3.58–4.40           –     8,000 B
  slice A/A             165 ns     234 ns    29.6%    1.00×      0.99–1.22           –         0 B
```

This is one of 3 runs on an Apple M2 Pro, with Homebrew's d8 15.8.62.9 and
a load average near 8. The ratios of `Float64Array.from` were 4.04, 3.81
and 3.90. Without the flags, the group led with the fastest round, as calls
under 1 µs that allocate little.

What each flag adds:

| Flag                     | What the count takes from it                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `--expose-statistics`    | `getV8Statistics()`, whose account of the bytes outside V8's heap holds the contents of the buffers. |
| `--expose-gc`            | `gc()`, which runs a scavenge before each sample, so that an object of benk's survives one.          |
| `--allow-natives-syntax` | `%InYoungGeneration()`, which shows whether that object has moved, as any collection moves it.       |

V8 takes the bytes of dead buffers off its account after a collection, so a
sample during which one ran can count too few. As in Node, such a sample
doesn't count, and the next has half as many calls. `D8Runtime` looks for
the three functions when it's created, and checks that a collection moves
the object. Without them it counts no buffers, and **buffers** shows `–`.

In 3 runs each of [`benchmarks/allocations/`](benchmarks/allocations/), on
an Apple M2 Pro, d8 15.8.62.9 counted the same buffers as Node 26.13.0, in
every run, but for a call that starts a collection itself:

| Call                             | heap in Node  | buffers in Node | buffers in d8 |
| -------------------------------- | ------------- | --------------- | ------------- |
| nothing                          | 0 B           | 0 B             | 0 B           |
| a small object                   | 32 B          | 0 B             | 0 B           |
| a heap number                    | 16 B          | 0 B             | 0 B           |
| `Uint8Array` of 64 B             | 280 B         | 0 B             | 0 B           |
| `Float64Array` of 1 KiB          | 200 B         | 1,024 B         | 1,024 B       |
| `Float64Array` of 64 KiB         | 200 B         | 65,536 B        | 65,536 B      |
| `Float64Array` of 1 MiB          | 200 B         | 1,048,576 B     | 1,048,576 B   |
| 30 arrays of 1 MiB and a buffer  | 31,459,528 B  | 1,048,576 B     | 1,048,576 B   |
| 100 arrays of 1 MiB and a buffer | 104,865,016 B | 1,048,576 B     | –             |

Each array holds 131,072 numbers, and the buffer is a `Float64Array` of
1 MiB.

The count has costs and gaps:

- **Time.** Before each sample, benk runs a scavenge and reads V8's
  statistics twice, and each read walks the heap. The 7 groups of small
  calls in `benchmarks/allocations/` took 0.77–0.80 s with the count, and
  0.68 s without, in 3 runs each: about 8 ms a variant. A walk takes
  longer as the heap grows, 10 ms with 40 MB alive.
- **A call that collects.** A sample during which a collection starts
  doesn't count, and benk halves the calls until a sample allocates too
  little to start one. A call that allocates more on the heap than V8's
  young generation holds starts a collection itself. Then even a sample of
  one call doesn't count, and **buffers** shows `–`. In the runs above, a
  call of 30 arrays counted, and a call of 100 didn't. In 20 samples of one
  call each, d8's `--trace-gc` printed a scavenge during every call of 100
  arrays, and none during a call of 30. Node counts buffers the same way,
  so it has the gap too, in some of its runs. In 27 runs of the group of
  100 arrays alone, Node 26.13.0 showed `–` for 8 of the 54 counts of the
  call and its A/A copy, and d8 for all 6 of 3 runs.
- **The heap.** A call that allocates only on the heap shows `0 B` of
  buffers, as `slice` does. Its group leads with the fastest round in d8
  where it could lead with the median in Node.
- **What V8 accounts.** The count reads all of V8's account of bytes
  outside its heap, which differs from Node's count of array buffers:

  | Allocation                                    | In d8       | In Node     |
  | --------------------------------------------- | ----------- | ----------- |
  | `SharedArrayBuffer` of 1 KiB                  | not counted | 1,024 B     |
  | `WebAssembly.Memory` of 1 page                | 65,536 B    | not counted |
  | resizable `ArrayBuffer` of 1 KiB, up to 4 KiB | 1,024 B     | not counted |

### Groups apart from the run

A script that calls `bench()` at its top level starts timing while it loads.
That suits Node, which runs the script. It doesn't suit a host that starts
the run itself, such as a Worker, which runs from its handler.

For such a host, declare the groups in a module that only exports them, as
`groups.ts`:

```ts
import type { Group } from 'benk/core';

const numbers = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

export const groups: Group[] = [
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
```

Importing it times nothing. Node's script, `bench.ts`, runs the groups as it
loads:

```ts
import { bench } from 'benk';
import { groups } from './groups.ts';

await bench(groups);
```

The host's script, `run.ts`, exports a function that runs the same groups.
It imports the `runtime` of [Runtimes](#runtimes)' script from a module of
its own, `runtime.ts`, which exports it:

```ts
import { formatGroup, measureGroups, type RunResult } from 'benk/core';
import { groups } from './groups.ts';
import { runtime } from './runtime.ts';

export function run(): Promise<RunResult> {
    return measureGroups(groups, {
        runtime,
        onGroup: group => {
            console.log(formatGroup(group).join('\n'));
        }
    });
}
```

The host calls `run()` when it's ready to time. These scripts were run in
Node only, where another script called `run()`.

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

## Array buffers outside the heap

V8 keeps the contents of an `ArrayBuffer` of more than 64 bytes outside its
heap, and with them those of a typed array or a `Buffer`. The **heap**
column leaves them out, so benk counts them apart, in the **buffers**
column. The two count together toward the 1 KiB from which a group leads
with the median round.

### Why they count toward the lead

[`benchmarks/array-buffers.ts`](benchmarks/array-buffers.ts) times calls
that allocate typed arrays, each in a group of its own. Before benk counted
buffers, 3 runs on an Apple M2 Pro with Node 26.13.0, with a load average
near 2, gave these:

| Call                      | heap    | Lead                 | median ÷ fastest | spread |
| ------------------------- | ------- | -------------------- | ---------------- | ------ |
| `number[]` of 128         | 1,074 B | median, by its bytes | 1.22–1.28        | 5–6%   |
| `Float64Array` of 1 KiB   | 200 B   | fastest              | 1.82–2.57        | 45–88% |
| `Float64Array` of 8 KiB   | 200 B   | fastest              | 1.15–1.47        | 58–86% |
| `Float64Array` of 100 KiB | 200 B   | fastest, in 2 runs   | 1.31–2.07        | 18–63% |
| `Float64Array` of 1 MiB   | 200 B   | median, by its time  | 1.53–1.60        | 11–15% |

The heap column counted only each typed array's object. So the groups of
up to 100 KiB led with the fastest round, as calls that allocate little.
Yet their median rounds took up to 2.6 times their fastest, against 1.3
times at most for an array of 1 KiB on the heap. The fastest round left out
work that the calls caused, as it does for calls that allocate on the heap.
The A/A copies' ratios by the fastest round ranged from 0.75 to 1.17. The
one of 0.75 lay outside its interval of 0.82–1.12, which benk noted.

With the count, 3 more runs gave each typed array's bytes, from 1,024 to
1,048,576. Each group led with the median round: by its bytes, or by its
time, as the group of 1 MiB did in each run and that of 100 KiB in one. The
A/A ratios, now the median of the per-round ratios, were 0.98 to 1.20, and
each interval held 1.

### How benk counts them

benk reads Node's count of array buffers' bytes,
`process.memoryUsage().arrayBuffers`, before and after a sample of a
variant's timer loop, apart from the timed rounds, as for heap bytes. A
garbage collection frees buffers, which benk can't add back as it does heap
bytes. V8 frees them after the collection, on a background thread, so a
`GCProfiler`'s statistics don't include them. So:

1. benk waits 1 ms before each sample, for V8 to free the buffers of
   earlier collections.
2. A sample in which a collection starts, or whose count falls, doesn't
   count. The next has half as many calls, until a sample allocates too
   little to start a collection, or is of one call.
3. The median of 5 samples that count is the call's bytes. A sample can
   still count too few, when V8 frees buffers during it.
4. If 5 samples don't count within 40, **buffers** shows `–`, and
   `arrayBufferBytes` is null. A call that starts a collection itself can
   end there, since a sample of one call doesn't count either, as
   [Bytes in d8](#bytes-in-d8) measures in Node and in d8.

In Node 24.22.3, 26.13.0 and 27.0.0-alpha on an Apple M2 Pro, 10 counts each
of 12 calls gave the right bytes, 360 of 360. The calls allocated from no
buffer to 16 MiB of them, some among objects on the heap. 31 of the 1,800
samples that counted counted too few. Without the wait, 32 of the 360 counts
ran out of samples, and gave `–`. With it, none did. In Node 24 and 26,
calls of 64 MiB and 256 MiB were counted right too.

The count adds about 10 ms to each variant. The 7 groups of
`benchmarks/array-buffers.ts` took 1.50–1.63 s with it, and 1.35–1.47 s
without, in 3 runs each.

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
source, whose types Node strips, it doesn't: the run's description and the
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

Or strip the types with a hook that detaches nothing. This repository's
tests, example and benchmark run with
[`@snovader/node-hooks`](https://www.npmjs.com/package/@snovader/node-hooks),
which strips them with oxc:

```sh
node --no-strip-types --import @snovader/node-hooks/register examples/numbers.ts
```

The example's constant `Float64Array` sum then took 1.41 µs from benk's
source, rather than 4.28–4.34 µs with Node's stripping, and
`--trace-protector-invalidation` printed nothing. These are the fastest
rounds of 3 runs each, on an Apple M2 Pro with Node 26.13.0. The process
state still records `'benk from TypeScript source'` and
`'entry script from TypeScript source'`, as these name where the code came
from, not what stripped its types.

## Known confounds

benk keeps these in view rather than out of the results:

- **A coarse clock.** A round's time is read to a tick of the runtime's
  clock, so a round that spans few ticks is read coarsely. On an Apple M2
  Pro with Node 26.13.0, with `performance.now()` floored and rounds of
  1 ms, 3 runs of a sum of 100 numbers gave these A/A ratios:

  | Ticks a round | A/A ratios          |
  | ------------- | ------------------- |
  | 1             | NaN, NaN, NaN       |
  | 5             | 1.000, 1.042, 1.042 |
  | 20            | 1.071, 0.961, 1.071 |
  | 50            | 1.000, 0.992, 0.999 |
  | not floored   | 1.001, 0.996, 0.999 |

  benk notes a group whose median rounds take less than 50 ticks, as
  [What the table reports](#what-the-table-reports) describes, but doesn't
  lengthen its rounds: a longer sample time does.

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

- **Buffers from a pool.** `Buffer.from()` of a short string, and
  `Buffer.allocUnsafe()` of a few bytes, take their bytes from a pool of
  64 KiB, which Node allocates anew when it runs out. A sample counts the
  pool only when it allocates one, so the **buffers** column varies between
  runs. Each such call takes 8 bytes of the pool. In 3 runs each in Node
  24.22.3 and 26.13.0, on an Apple M2 Pro, `Buffer.from('abc')` counted 5.8
  to 12.8 bytes, and `Buffer.allocUnsafe(3)` 0 to 8.7.

- **The tier of the timed code.** A variant's calls run in the code of the
  tier that V8 compiled them to, and rounds of 1 ms can end before Turbofan
  compiles a timer loop. The quick start's for loop took 1.41 µs with the
  default sample time, when no Turbofan compilation considered its `run`,
  and 795 ns with `--sample-ms 10`, when Turbofan inlined `run` and
  `sumLoop` into its timer loop. These are the fastest rounds of 3 runs of
  each, on an Apple M2 Pro with Node 26.13.0. [V8's report](#v8s-report)
  shows the tiers.

- **The width of small integers.** V8 keeps an integer in place of a
  pointer, as a small integer, when it fits: in 32 bits in Node, and in 31
  where V8 compresses pointers, as in d8, workerd and Chrome. There, an
  integer from 2³⁰ to 2³¹ − 1 is a number on the heap. So code that handles
  such integers can take more or less time in a Worker or a browser than in
  Node, and a benchmark in Node doesn't show it.
  [`benchmarks/small-integers/`](benchmarks/small-integers/) does the same
  work on 1,000 integers just below 2³⁰, and on as many from 2³⁰, with the
  same groups in Node and in d8. These are the ratios of the second to the
  first, by the median round, in 3 runs of each, on an Apple M2 Pro with
  Node 26.13.0 and d8 15.8.62.9, with a load average near 2:

  | Integers held in | Node, 1 ms | Node, 10 ms | d8, 1 ms  | d8, 10 ms |
  | ---------------- | ---------- | ----------- | --------- | --------- |
  | object fields    | 0.99–1.02  | 1.00        | 1.09–1.10 | 1.06–1.08 |
  | `number[]`       | 1.00–1.01  | 0.99–1.00   | 0.90      | 0.91–0.92 |
  | `Int32Array`     | 1.00–1.01  | 1.00        | 0.95      | 0.97–1.00 |
  | A/A copies       | 0.99–1.01  | 0.99–1.01   | 0.99–1.01 | 1.00–1.01 |

  The columns are of rounds of 1 ms and of 10 ms, as `--sample-ms` sets.
  Each of d8's intervals for object fields and `number[]` left out 1, and
  each of Node's held it.

  In d8, each new object's field held a heap number. In runs apart from the
  timed ones, with V8's `--trace-gc-nvp`, a call allocated about 28,200
  bytes in d8, against 15,900, and 10,000 calls collected 68 times, against
  38. In Node, both allocated about 31,700 bytes a call, and collected 38
  and 39 times. In d8, the `number[]` held doubles, which V8 stores without
  checking that they fit in 31 bits.

  The `Int32Array` holds 32-bit integers either way. With rounds of 1 ms,
  its calls ran in Maglev's code, which V8 compiled from feedback that saw
  heap numbers for the larger integers, and which took 5% less time with
  them. With 10 ms, Turbofan's code took over after 9 or 10 of the 36
  rounds, and the ratios came closer to 1.

  Time code in d8, with `benk/d8`, when it will run in a Worker or a
  browser, and compare ratios within one engine. Node's V8 and d8's are
  different versions, so a time in one against a time in the other compares
  the versions too.

## Planned

Not built yet:

- **Comparing two revisions.** Build each git revision into a copy of its
  own, load both in one process, and interleave them as variants, with
  position rotation across processes as well as rounds, since V8's tiering
  can favour the first copy that a process loads.
- **Each timer loop named by its variant.** V8's report ties a timer loop
  to its variant through the variant's `run`, as
  [By variant](#by-variant) describes, which leaves out a loop that only
  Maglev compiled. Naming each loop would need the core to tell the runtime
  which variant a loop is for, and Node's loops a name that V8's traces
  print. V8 doesn't print a `new Function`'s `//# sourceURL=`.
- **A `bench` API in hypotes**, Vitest's `bench()` on node:test, layered over
  benk.
- **Runtimes for browsers and Workers**, with timer loops written at build
  time and no heap bytes, in place of the one that a script writes itself,
  as [Runtimes](#runtimes) describes.
- **Position effects in the report.** The JSON has each round's position;
  the table could flag a variant whose time depends on it.

## Development

[`AGENTS.md`](AGENTS.md) has the guidelines for changing benk, and the checks
to run.

## License

[MIT](LICENSE)
