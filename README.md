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
  them, or change partway, is flagged rather than averaged.
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
- **Ratios across processes.** `--processes 5` runs the script again in 4
  more processes, and prints each variant's ratio in each, with their
  median and range, as an interval of one process's rounds can't show how
  a ratio varies between processes.

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

| Option                      | Default | What it does                                                                                                                                           |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--rounds <n>`              | 31      | Sets the timed rounds, at least. benk runs whole rotations, so a group of 3 variants and its A/A copy runs 32.                                         |
| `--warmup-rounds <n>`       | 10      | Sets the rounds before the timed ones, after which each variant's calls per round are counted again.                                                   |
| `--sample-ms <ms>`          | 1       | Sets the time of one variant's round.                                                                                                                  |
| `--filter <regex>`          |         | Measures only the groups whose name matches.                                                                                                           |
| `--json <path>`             |         | Writes the results as JSON to a file. benk checks that it can write to the file's directory before it measures.                                        |
| `--json -`                  |         | Writes the JSON to stdout, and the tables to stderr.                                                                                                   |
| `--processes <n>`           | 1       | Measures in n processes: this one, then the script again in n − 1 more. Prints each ratio in each, as [Across processes](#across-processes) describes. |
| `--no-aa`                   |         | Leaves out the A/A copies. A group's `aa` overrides it.                                                                                                |
| `--no-heap`                 |         | Leaves out the counts of bytes allocated, on the heap and in array buffers.                                                                            |
| `--v8-report`               |         | Runs the script again with V8's traces, after measuring, and prints [V8's report](#v8s-report) of its hot functions.                                   |
| `--v8-filter <regex>`       |         | Lists only the functions whose name matches in V8's report, and implies `--v8-report`.                                                                 |
| `--v8-check`                |         | Checks the functions of V8's report, and exits with 2 if one fails, as [The check](#the-check) describes. Implies `--v8-report`.                       |
| `--v8-max-bytecode <bytes>` |         | Fails the check for a hot function of more bytecode than this. Implies `--v8-check`.                                                                   |

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

### Variants from one function

A script often makes its variants from one function, with a variant for
each class or each size. V8 keeps what it learns of a call site, its type
feedback, with the function's code, which every closure of that function
shares. So each variant is timed through call sites that have seen every
variant's types, and not as code that uses one type runs.

`compiledCopy(fn)` compiles a function again from its text, as a source of
its own, whose feedback no other function shares. This script, `bench.ts`,
sums typed arrays of 6 types, each with a copy of `sumOf`:

```ts
import { bench, compiledCopy, type Variant } from 'benk';

const TYPES = [
    Int8Array,
    Uint8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array
];

/** Takes what the call needs, and returns the call that a variant runs */
function sumOf(values: ArrayLike<number>): () => number {
    return () => {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i];
        }

        return sum;
    };
}

const variants: Variant[] = TYPES.map(TypedArray => ({
    name: TypedArray.name,
    run: compiledCopy(sumOf)(new TypedArray(1000).fill(1))
}));

await bench([{ name: 'sum 1,000 numbers', variants }]);
```

```sh
node bench.ts --sample-ms 10
```

```text
sum 1,000 numbers: 42 rounds, by the fastest round (every call under 1 µs and 1 KiB)
                      fastest     median   spread    ratio   95% interval        heap     buffers
  Int8Array            340 ns     348 ns     3.8%    1.00×                        0 B         0 B
  Uint8Array           339 ns     349 ns     2.7%    1.00×      1.00–1.01         0 B         0 B
  Int16Array           339 ns     350 ns     2.1%    1.00×      0.99–1.01         0 B         0 B
  Uint16Array          339 ns     350 ns     3.1%    1.00×      0.99–1.01         0 B         0 B
  Int32Array           339 ns     353 ns     4.7%    1.00×      1.00–1.01         0 B         0 B
  Uint32Array          489 ns     506 ns     3.0%    1.44×      1.43–1.46         0 B         0 B
  Int8Array A/A        341 ns     351 ns     3.0%    1.00×      1.00–1.01         0 B         0 B
```

With `run: sumOf(new TypedArray(1000).fill(1))`, the shared `values[i]`
saw all six array types. Median rounds took 3.60 to 4.01 µs. For
`Int8Array`, that was 11.2 to 11.5 times as long as with a copy.
`Uint32Array`'s ratio to `Int8Array` fell from 1.43–1.45 with copies to
1.00–1.01 with the shared function. These are from three runs of each
version on an Apple M2 Pro with Node 26.13.0.
[Known confounds](#known-confounds) has another measurement.

A copy has only its text. What that means for the function to copy:

- **It reads no variable of the scope that it was written in**: none of its
  module, none of a function around it, and no import. It reads its
  parameters, what it declares itself, and globals. So it takes what its
  calls need as parameters, and returns the call, as `sumOf` does. A name
  that it reads from its scope anyway is a `ReferenceError` when the copy's
  code reaches it, not when it's copied. If a global has that name, the
  copy reads the global.
- **Its text is an expression**: an arrow function, a `function`, also an
  async one or a generator, or a class. A method written as `name() {}`, a
  getter, a bound function and a built-in aren't, and `compiledCopy()`
  throws a `SyntaxError` for them.
- **The copy is strict code**, as a module's code is.
- **The text is what the host runs.** It has no types where Node or a hook
  stripped them, and it has a bundler's or a minifier's names, which a copy
  runs with as well. A build that rewrites the function to call a helper of
  its own, as one for an older target can, makes it read that helper from
  its scope, which a copy can't.
- **V8's report can't tell copies apart.** V8 names the code of each as
  `(anonymous) <anonymous>`, at the same line and column for copies of one
  function. [By variant](#by-variant) then lists their compilations and
  timer loops together, under each of the variants.

`compiledFrom(source)` compiles the text of a function expression in the
same way. It's for a call whose text differs between variants, such as by
the name of the method that it calls:

```ts
import { bench, compiledFrom, type Variant } from 'benk';

const view = new DataView(new ArrayBuffer(8));
const METHODS = ['getInt8', 'getUint16', 'getInt32', 'getFloat64'];

type Read = (view: DataView) => () => number;

const variants: Variant[] = METHODS.map(method => ({
    name: method,
    run: compiledFrom<Read>(`view => () => view.${method}(0)`)(view)
}));

await bench([{ name: 'read a number', variants }]);
```

Two functions from the same text are sources of their own too. It throws a
`SyntaxError` for text that isn't an expression, and a `TypeError` for an
expression that isn't a function.

Both compile a string, which Workers and some browsers' pages forbid. So
`benk` and `benk/d8` export them, and `benk/core` doesn't.

### Inputs in turn

A call that passes the same input every time can be compiled for that
input, as [Known confounds](#known-confounds) measures. `inTurn(inputs)`
returns a function that returns the inputs one after another, and the
first again after the last:

```ts
import { bench, inTurn } from 'benk';

const arrays = Array.from({ length: 4 }, (_, turn) =>
    Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i + turn))
);

function sumLoop(values: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }
    return sum;
}

const next = inTurn(arrays);

await bench([
    {
        name: 'sum 1,000 numbers',
        variants: [{ name: 'for loop', run: () => sumLoop(next()) }]
    }
]);
```

Give each variant a function of its own, of inputs of one kind: objects of
one class, or arrays of one type of element. One function that two
variants call gives each of them only some of the inputs. Inputs of several
kinds time the call as a caller of them all runs it, which is another
benchmark.

The inputs are in turn over a variant's calls, in whatever round. A call
that changes its input needs fresh input for each call, which `setup`
prepares, as [Variants](#variants) describes.

`inTurn()` keeps a copy of the array and throws a `RangeError` for an empty
one. Each call compiles its function from a source of its own, so
`benk/core` doesn't export it. In
[`benchmarks/inputs-in-turn.ts`](benchmarks/inputs-in-turn.ts), reading one
number took 2.98 to 3.22 ns with a counter by hand and 2.99 to 3.20 ns with
`inTurn()`. A generator step took 7.73 to 8.19 ns across all three variants.
These are the fastest rounds from six runs on an Apple M2 Pro with Node
26.13.0. [Known confounds](#known-confounds) compares the constant input
with the rotating inputs.

### Lines after the tables

A script that prints lines of its own after the tables, such as the sizes
of what its variants encode, prints them where the tables went: with
`--json -`, that's stderr. `bench()` hands its `print` to the `after`
option, which it calls last, with the results:

```ts
import { bench } from 'benk';

const text = 'benk '.repeat(200);
const encoder = new TextEncoder();

await bench(
    [
        {
            name: 'encode 1,000 characters',
            variants: [{ name: 'TextEncoder', run: () => encoder.encode(text) }]
        }
    ],
    {
        after: (print, result) => {
            for (const group of result.groups) {
                print('');
                print(`${group.name}: ${encoder.encode(text).length} bytes`);
            }
        }
    }
);
```

After the group's table, it prints:

```text
encode 1,000 characters: 1000 bytes
```

`bench()` awaits `after`, and rejects with what it throws. By then it has
written the JSON. The traced run of `--v8-report`, and the other processes
of `--processes`, show nothing, so they don't call `after`, although they
run the script's code after `bench()`. In d8, `after` comes before the
tables across processes, as [In d8](#in-d8) describes.

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
  If the clock reads zero for the reference and the ratio is undefined or
  infinite, the table shows a dash and the JSON records `null`.
- **95% interval**: a confidence interval of the median of the per-round
  ratios, from their order statistics, which assumes nothing about the
  rounds' distribution. An interval that leaves out 1 says that the variant
  differed from the reference round by round. The A/A row's shows how wide
  an interval is when nothing differs. It's left out with fewer than 6
  rounds or when either endpoint is unmeasurable. In a group that leads
  with the fastest round, the ratio compares the fastest rounds instead.
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
  A variant whose rounds changed partway gets the next note in its place.
- **the first … rounds ran near …, and the other … near …**: a note for a
  variant whose rounds changed partway, as
  [Rounds that changed](#rounds-that-changed) describes. Its median then
  mixes the rounds before and after the change, or describes one of them.
  A change in the second half names the last rounds instead.
- **its rounds ran near … when … in a round, and near … otherwise**: a note
  for a variant whose rounds in one position of the round took longer or
  shorter than its others, as [Position effects](#position-effects)
  describes.
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

### Rounds that changed

A variant's rounds can change partway through the run. Its first rounds can
run in code that V8 hasn't optimized yet, and load from other processes can
start or stop at any round. The median then mixes the rounds before and
after the change, or describes one of them. A note says when each ran:

```text
  for loop: the first 4 rounds ran near 1.47 µs, and the other 32 near 830 ns: try a longer warm-up and check whether the early slowdown repeats
```

This is the quick start's for loop with `--sample-ms 10`, in the run that
[V8's report](#v8s-report) shows. Its first 4 rounds ran before Turbofan's
code took over, and its median is of the other 32.

The note's suggestion depends on whether the rounds got faster or slower:

| Later rounds | Possible cause        | What to try                                              |
| ------------ | --------------------- | -------------------------------------------------------- |
| Faster       | V8 optimized the code | Repeat with more warm-up rounds and compare the timings. |
| Slower       | V8 deoptimized        | Repeat and check V8's report for a deoptimization.       |

Load from another process can start or stop during the run. Look for a
change in the same rounds across variants, including the A/A copy. V8
optimizes each variant's timer loop on its own, but the reference and its
A/A copy call the same `run`, which can tier up in both loops at about the
same round.

benk compares the rounds on either side of each possible split by rank,
using the Mann–Whitney rank sum. A split qualifies when:

- each part has at least 3 rounds and 10% of them, as each of two modes;
- the rank sum of the rounds before the split is 3 or more standard
  deviations from its mean;
- 95% or more of the pairs of a round before and a round after are ordered
  as the two parts' medians are;
- the medians are 5% or more apart.

Among the qualifying splits, benk chooses the one that minimizes the sum
of squared deviations from each part's mean log time. This lets it locate
a short early slowdown even when the later rounds drift by a few percent.

In shuffled rounds, whose order doesn't matter, benk found a change in
0.13% to 0.17% of 31 to 40 rounds, and in none of 12 rounds or fewer, where
a split that clean is too likely by chance. It looks for one change: a
steady drift reads as a change near its middle.

On an Apple M2 Pro with Node 26.13.0, benk timed 426 variants in 48 runs:
6 each of the quick start with `--sample-ms 10` and with the default 1 ms,
of `examples/numbers.ts`, of `benchmarks/`' loops, array buffers and
allocations, and of its small integers with 1 ms and with 10 ms. With a
load average near 5, 78 variants got the note:

| Variants                                                     | Notes    | What changed                                                                  |
| ------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------- |
| The quick start's for loop and its A/A copy, with 10 ms      | 12 of 12 | The first 4 or 5 rounds took 1.7 to 1.8 times as long, before Turbofan's code |
| The small integers' `Int32Array` and `number[]`, with 10 ms  | 35 of 36 | The first 8 to 11 rounds took 1.4 to 2.7 times as long                        |
| The allocations' and array buffers' `Float64Array` of 1 MiB  | 22 of 24 | The first 7 to 13 rounds took a third to a sixth as long                      |
| The other 354                                                | 9        | Such as the last 7 to 10 rounds of a group, which load slowed alike           |

With 1 ms, the quick start's for loop got no note, as no Turbofan
compilation considered its `run`. With a load average of 30 to 47, 60
variants got it: the quick start's in 9 of 12, as load slowed some later
rounds as much as the first, and more variants whose rounds load changed.

### Position effects

A variant's time can depend on its position in the round, as on what runs
just before it: garbage that another variant leaves to collect, or data
that another evicts from a cache. The rotation takes every variant through
every position equally often, so its median mixes the positions alike. A
note says when one position's rounds differ from the variant's others:

```text
  Float64Array of 1 KiB: its rounds ran near 330 ns when 1st in a round, and near 246 ns otherwise
```

benk compares the rounds in each position with the variant's other rounds
by their ranks, as for a change. A position qualifies when:

- its rank sum is 3.7 or more standard deviations from its mean;
- its median differs from the median of the other rounds by at least 5%
  of the faster median.

Of the positions that qualify, the note names the one with the greatest
rank distance. A tie goes to the earliest position, as when there are only
two.

A position has few rounds: 31 rounds over 3 to 7 positions give 6 to 12
each, which noise easily makes look different. So the bar is high. In
shuffled rounds, with the rotation's positions, 0.004% to 0.014% of
variants got the note. A position whose every round is slower than the
others reaches it with up to 7 positions of 6 rounds each, and 8 positions
of 4 can't.

Within a complete rotation, each variant immediately follows every other
variant equally often within rounds. A given pair can still occur at a
fixed position. With four variants numbered from 0, variant 3 precedes
variant 0 only when variant 0 runs second within the round. A slowdown in
that position could reflect what variant 3 left behind. A periodic change
in the workload can also line up with the rotation.

In the runs of [Rounds that changed](#rounds-that-changed), 48 with each
load average, 1 of 852 variants got the note, and none of the 336 A/A
copies. It was the run above, of `benchmarks/array-buffers.ts`. Its A/A
copy's rounds leaned the other way in the same run, and the group's 11
other runs didn't differ by position.

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

## Across processes

A process has one set of V8's decisions: which code it compiles to which
tier, and when, where it places objects on the heap, and the order in which
it loads modules. Each of its rounds shares them. So a ratio's 95% interval,
which is of the rounds of one process, can't say how the ratio varies
between processes. `--processes <n>` measures in n processes, and prints
each variant's ratio in each:

```sh
node bench.ts --processes 5
```

```text
Node v26.13.0, V8 14.6.202.34-node.40, darwin arm64, Apple M2 Pro. Process state: entry script from TypeScript source.
Per call, of at least 31 interleaved rounds of 1 ms per variant after 10 warm-up rounds, in an order that rotates each variant through each position:
the fastest and median round, the interquartile range as a share of the median, the ratio to the group's first variant by the statistic that the group leads with, a 95% interval of the median of the per-round ratios, and the bytes allocated on the heap and in array buffers outside it.

sum 1,000 numbers: 36 rounds, by the median round (a call of 1 µs or more)
                      fastest     median   spread    ratio   95% interval        heap     buffers
  for loop            1.45 µs    1.49 µs     3.2%    1.00×                       16 B         0 B
  reduce              7.12 µs    7.55 µs     7.1%    5.08×      4.99–5.20    32,040 B         0 B
  for loop A/A        1.44 µs    1.47 µs     3.1%    1.00×      1.00–1.01        16 B         0 B

In 5 processes, the first of them the run above, and the others its repeats: each variant's ratio in each, by the statistic that its group leads with in the first, the median of the 5 ratios, and their range.

sum 1,000 numbers: 5 processes, by the median round
                         1       2       3       4       5   median          range
  for loop           1.00×   1.00×   1.00×   1.00×   1.00×    1.00×
  reduce             5.08×   5.04×   5.00×   5.05×   5.02×    5.04×      5.00–5.08
  for loop A/A       1.00×   1.00×   1.00×   1.00×   1.00×    1.00×      1.00–1.00
```

benk measures in this process first, and prints its tables as it does
without the option. Then it runs the script again in 4 more processes, one
after another, and prints a table of each group: a column for each
process, then the median of their ratios and their range. This is one of 3
runs of the quick start's `bench.ts` on an Apple M2 Pro with Node 26.13.0,
with benk's bundle in another project and a load average near 5. The ratios
of `reduce` ranged 5.00–5.08 in this one, and 5.01–5.07 and 5.05–5.10 in
the others, within its interval in the first process of each.

Each ratio is by the statistic that its group leads with in the first
process, whose table names it. A process whose group led with the other
statistic, as when its calls ran in another tier, gets its ratio from its
rounds, as the first process compares them. A note below the table names
such a process, as its ratio then differs from the one that its own table
would have printed:

```text
  process 3 led with the median round: its ratios here are by the fastest round, from its rounds
```

| Column or note                                                              | What it says                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1` to `5`                                                                  | The ratio in each process. The first is the run whose tables are above.                                                                                                                                                                                                                                                                                                                                |
| **median**                                                                  | The median of the ratios. Of an even count, it's the greater of the middle two, so that it's a process's ratio. With 2 processes, there's none.                                                                                                                                                                                                                                                        |
| **range**                                                                   | The least and the greatest of the ratios.                                                                                                                                                                                                                                                                                                                                                              |
| `the intervals of processes 1 and 3 don't overlap, 0.61–0.63 and 0.90–0.93` | The processes have disjoint 95% confidence intervals for their median per-round ratios. Individual rounds in the two processes can still overlap. In a group that leads with the fastest round, the note starts `round by round`: the intervals are of the median of the per-round ratios, as in each process's table, and the ratios beside them of the fastest rounds.                               |
| `faster than for loop in 2 processes, and slower in 3`                      | The variant's ratios, as printed, lie on both sides of 1: which of the two is faster depends on the process. A ratio that prints as 1.00 is neither. An A/A copy gets no such note.                                                                                                                                                                                                                    |
| `median 1.02×, no further from 1 than the A/A copy's median, 1.03×`         | The variant's median ratio is no further from 1 than the A/A copy's: it differs from the reference by no more than identical code does in the median process. The medians compare like with like: the A/A copy's furthest ratio, of one process, would dismiss a variant that differed alike in every process. A median that prints as 1.00 shows no difference, and gets no such note.                |

If a process has no measurable ratio, its cell shows a dash. The median and
range also show dashes because both summarize the full set of processes.
The JSON records each missing value as `null`.

The processes are few, as each runs the whole script, so benk gives their
range rather than an interval. Like the rounds' 95% interval, the range is
an interval of order statistics, which assumes nothing about the ratios'
distribution. If the processes are alike and independent, it holds the
median ratio of a process with a confidence of 1 − 2¹⁻ⁿ:

| Processes | Confidence that the range holds the median |
| --------- | ------------------------------------------ |
| 2         | 50%                                        |
| 3         | 75%                                        |
| 4         | 88%                                        |
| 5         | 94%                                        |
| 6         | 97%                                        |

With 2 processes, the table has no **median** column, and the JSON's
`median` is `null`: the median of two would be the greater of them. Their
range holds a process's median ratio only half the time, as the paragraph
above the tables says. Use 3 or more for a range to go by.

What the other processes do:

1. Each runs the script with the same arguments, and with the flags that
   Node started this process with. benk sets `BENK_PROCESS_RUN` in its
   environment, where `bench()` measures as it does otherwise, and formats
   the tables, but prints nothing, writes no JSON and doesn't call `after`.
   It runs no process of its own, for `--processes` or `--v8-report`. It
   writes its results to a temporary file, which the first process reads.
2. benk sets `BENK_PARENT_PID` too, to the first process's pid. A process
   that the script starts in turn, as with `spawnSync()`, inherits both
   variables, but its parent isn't the first process. So it runs as any
   other: it prints, and writes no results for the first process.
3. They run one after another, after the first has measured, so that they
   don't load each other.
4. A script that does more than call `bench()`, such as writing files, does
   it in each process. What it writes to stdout in another process doesn't
   show. What it writes to stderr does, as an error does.
5. A script that calls `bench()` more than once makes each call in each
   process. Each call of the first process takes the other processes'
   results from the same runs, so the script runs n times in all.
6. If a run in another process fails, or measures other groups or variants
   than the first, `bench()` writes the JSON without the other processes,
   and then throws.

With the other options:

- `--filter` selects the same groups in every process.
- `--json` writes the results with the other processes', as
  [JSON results](#json-results) describes. With `--json -`, the tables
  across processes go to stderr, with the others.
- `--v8-report` runs the traced run after the other processes, and prints
  the report after the tables across processes. The report is of one
  traced run, a process of its own.

Each process adds about as long as the script takes alone. These are 3 runs
of each, on the same machine. The first two were run from this repository,
with benk's source, and a load average of 1.3 to 3.2:

| Script                                       | Alone       | `--processes 5` |
| -------------------------------------------- | ----------- | --------------- |
| [`examples/numbers.ts`](examples/numbers.ts) | 0.59–0.62 s | 2.92–3.19 s     |
| [`benchmarks/loops.ts`](benchmarks/loops.ts) | 0.64–0.66 s | 3.21–3.35 s     |
| The quick start's `bench.ts`, bundled        | 0.35–0.48 s | 1.73–1.75 s     |

In those 6 runs of `--processes 5`, no two processes' intervals of a
variant were apart, of the 33 variants that weren't references. For 30 of
them, the 5 processes' ratios spanned less than the median width of one
process's interval, and for the others at most 1.3 times as much. The
longest span was of `number[]`'s sort in `examples/numbers.ts`, 5.69–6.63,
whose intervals each spanned about 20%. With `--sample-ms 3` and `5`, the
sums of `examples/numbers.ts` agreed as closely: `reduce` ranged 4.90–4.96
and 8.44–8.53. So for these scripts, one process's interval didn't
understate how the ratios varied between processes. That's a measurement of
them, not of every script: the option is how to check another.

## JSON results

`--json` writes a `RunResult`, whose types `benk` exports:

```jsonc
{
  "schema": 7,
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
      "change": null,                     // the change in its rounds partway, or null
      "positionEffect": null,             // a position whose rounds differ, or null
      "ratio": 1, "interval": null, "heapBytes": 16, "arrayBufferBytes": 0,
      "v8": null                          // what V8 did with its code, with --v8-report
    }]
  }],
  "processes": null,                     // the other processes, with --processes
  "v8Report": null                        // V8's report, with --v8-report
}
```

`schema` changes when a field does. A variant's `change` has the median
and the count of the rounds `before` the change and `after` it, as
[Rounds that changed](#rounds-that-changed) describes. Its
`positionEffect` has the `position` whose rounds differ, from 0, and the
`median` round there and in the `others`, as
[Position effects](#position-effects) describes. `v8Report`, and each
variant's `v8`, are V8's report, which `--v8-report` adds, as
[In the results](#in-the-results) describes. They're `null` without it, in
the results of `measureGroups()`, and in d8. The runtime's flags include
`NODE_OPTIONS`, as V8's flags change what's measured. Its process state is
what benk knows of the process that changes what's measured, as
[Typed arrays and detached buffers](#typed-arrays-and-detached-buffers)
describes.

`processes` is `null` without `--processes`, with `--processes 1`, and in
the results of `measureGroups()`. With more processes, `groups` are the
first process's, and `processes` has the others', and each variant's
ratios in all of them:

| Field              | What it has                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processes.runs`   | The runs after the first, in the order that they ran: each one's `date`, `runtime` and `groups`, as the first's. A run's flags and process state can differ from the first's.                                                                                                   |
| `processes.groups` | Each group's `name`, its `lead` in the first process, its `leads` in each process's own run, and its `variants`: each one's `name`, `role`, `ratios` in each process from the first, `intervals` in each, or `null` for none, `median`, or `null` for 2 processes, and `range`. |

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
  for loop             819 ns     832 ns     0.9%    1.00×                       16 B         0 B
  reduce              7.21 µs    7.37 µs     1.4%    8.86×      8.78–8.88    32,040 B         0 B
  for loop A/A         821 ns     830 ns     0.5%    1.00×      1.00–1.00        16 B         0 B
  for loop: the first 4 rounds ran near 1.47 µs, and the other 32 near 830 ns: try a longer warm-up and check whether the early slowdown repeats
  for loop A/A: the first 4 rounds ran near 1.48 µs, and the other 32 near 829 ns: try a longer warm-up and check whether the early slowdown repeats

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

By variant, of the tables: where V8 placed its run, the tiers that V8 compiled the run to on its own, and its timer loops that the traces tie to the run, with their tiers, what Turbofan inlined into them of the script's functions, and the deoptimizations of both.
sum 1,000 numbers
  for loop: run bench.ts:17:38, 13 B of bytecode, compiled to Maglev
    2 timer loops, also of for loop A/A, compiled to Maglev ×2, Turbofan ×2
    inlines run bench.ts:17:38 (13 B) ×2
    inlines sumLoop bench.ts:5:17 (38 B) ×2
  reduce: run bench.ts:20:22, 24 B of bytecode, compiled to Maglev
    no timer loop that the traces tie to its run
  for loop A/A: run bench.ts:17:38, 13 B of bytecode, compiled to Maglev
    2 timer loops, also of for loop, compiled to Maglev ×2, Turbofan ×2
    inlines run bench.ts:17:38 (13 B) ×2
    inlines sumLoop bench.ts:5:17 (38 B) ×2

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
for loop took 1.41 to 1.45 µs rather than 808 to 821 ns. These are the
fastest rounds of 3 runs of each, on an Apple M2 Pro with Node 26.13.0 and a
load average near 6, with benk's bundle in another project, and each sample
time's 3 reports were the same. The notes with 10 ms are of the rounds
before Turbofan's code: the first 4 to 7, near 1.47 to 1.52 µs, as
[Rounds that changed](#rounds-that-changed) describes.

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
     for loop             819 ns     837 ns     2.3%    1.00×                          –           –
     reduce              6.41 µs    6.56 µs     1.3%    7.88×      7.76–7.91           –           –
     for loop A/A         818 ns     836 ns     1.9%    1.00×      1.00–1.01           –           –
     for loop: the first 5 rounds ran near 1.50 µs, and the other 31 near 832 ns: try a longer warm-up and check whether the early slowdown repeats
     for loop A/A: the first 5 rounds ran near 1.48 µs, and the other 31 near 832 ns: try a longer warm-up and check whether the early slowdown repeats

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
with Homebrew's d8 15.8.62.9 and a load average near 6, whose reports were
the same. With the default rounds of 1 ms, the report had no line of
inlining in 3 runs, and the for loop's fastest round took 1.45 to 1.47 µs,
against 818 to 824 ns with 10 ms. In one of the runs with 10 ms, Turbofan's
code took over only after the for loop's first 14 rounds, and its note said
so.

- The first run gets the script's options but `--v8-report` and
  `--v8-filter`, which benk-d8 carries out. The traced run gets none of
  those, nor `--json` or `--processes`, so it writes no results.
- In the traced run, benk-d8 marks the process before the script loads.
  `bench()` measures the groups and returns their results, but prints no
  tables, writes no JSON and doesn't call `after`.
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
  starts.
- The report tells benk's functions by their files: those of benk's
  bundle, which a script imports from `node_modules/benk/dist`, or which a
  bundle's source map names. A bundle that has benk in it, without a
  source map, can't tell them from the script's.

benk-d8 carries out `--processes` too, as [Across processes](#across-processes)
describes it in Node, but runs d8 once for each process:

```sh
npx benk-d8 bench.mjs -- --processes 5
```

- Each of d8's runs prints its tables, and writes its results to a
  temporary file of benk-d8's, by `--json`, in place of the script's. Only
  the first run's output shows.
- benk-d8 marks the runs after the first before the script loads, as it
  marks the traced run. Their `bench()` doesn't call `after`, as in Node.
  The first run's `bench()` calls it, with that run's results, whose
  `processes` is null, before benk-d8 prints the tables across processes.
  In Node, `after` comes after those tables, and has the other processes'
  results too.
- For multiple processes the bundle and benk-d8 must use the same result
  schema. If they differ, rebuild the script with the version of benk that
  supplies benk-d8.
- benk-d8 then prints the tables across processes, and writes the results
  where the script's `--json` says, with the other processes'.
- d8 writes the file at each call of `bench()`, so the results and the
  ratios across processes are of the script's last call, as `--json` alone
  writes them.
- If the first run fails, benk-d8 exits with d8's code. If another fails,
  or measures other groups, benk-d8 prints an error, and exits with 1.

In one run of `bench.mjs` on the same machine, with Homebrew's d8
15.8.62.9, `reduce`'s ratios ranged 4.44–4.50 in 5 processes. benk-d8 took
1.34 s, and d8 alone 0.17 s.

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
   script that does more, such as writing files, does it twice. benk sets
   `BENK_PARENT_PID` too, so that a process that the traced run starts,
   which inherits both, runs as any other, as in
   [Across processes](#across-processes).
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
| `compiledCopy(fn)`                    | Returns a copy of a function, compiled from a source of its own, as [Variants from one function](#variants-from-one-function) describes.                                  |
| `compiledFrom(source)`                | Returns a function compiled from the text of a function expression, as a source of its own.                                                                               |
| `inTurn(inputs)`                      | Returns a function that returns the inputs one after another, as [Inputs in turn](#inputs-in-turn) describes.                                                             |
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
arguments, `runtime`, `print` and `write` in place of the console and
stdout, and `after`, which [Lines after the tables](#lines-after-the-tables)
describes.

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

`benk/core` exports what `benk` does, except these, which need Node, or
compile a string:

| Export           | What to do without it                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench()`        | Call `measureGroups()`, and print with `describeRun()` and `formatGroup()`. In d8, import `bench()` of `benk/d8`.                             |
| `NodeRuntime`    | Pass a `Runtime` as the `runtime` option, which `benk/core` requires.                                                                         |
| `compiledCopy()` | Write a function for each variant, or generate them at build time. In d8, import it of `benk/d8`.                                             |
| `compiledFrom()` | As `compiledCopy()`.                                                                                                                          |
| `inTurn()`       | Keep a counter in the variant, as [`benchmarks/inputs-in-turn.ts`](benchmarks/inputs-in-turn.ts) does by hand. In d8, import it of `benk/d8`. |

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

`benk/d8` exports d8's `bench()` and runtime, and what compiles a string,
and loads none of Node's modules:

| Export                    | What it does                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bench(groups, options?)` | Runs a benchmark script in d8, as `benk`'s `bench()` does in Node, with the options that d8 can carry out.                                     |
| `D8Runtime`               | Times variants in d8, each in a timer loop that `new Function` compiles, as in Node, and with three of d8's flags counts array buffers' bytes. |
| `compiledCopy(fn)`        | Returns a copy of a function, compiled from a source of its own, as `benk`'s does.                                                             |
| `compiledFrom(source)`    | Returns a function compiled from the text of a function expression, as `benk`'s does.                                                          |
| `inTurn(inputs)`          | Returns a function that returns the inputs one after another, as `benk`'s does.                                                                |

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
| `--processes <n>`                                                   | Throws for more than 1, before it measures, as d8 can't start a process. [`benk-d8`](#in-d8) runs d8 once for each process, and carries it out.                               |
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
  data runs it, which [`inTurn()`](#inputs-in-turn) is for.

  [`benchmarks/inputs-in-turn.ts`](benchmarks/inputs-in-turn.ts) times
  calls with one `Float64Array` of 1,000 numbers and with 4 in turn.
  Each entry spans the fastest rounds from 3 runs at each sample time on
  an Apple M2 Pro with Node 26.13.0 and the packed benk bundle. The ratio
  compares the fastest rounds within each run.

  | Call                 | One input    | 4 with `inTurn()` | Ratio       |
  | -------------------- | ------------ | ----------------- | ----------- |
  | Sum, rounds of 1 ms  | 1.45–1.51 µs | 1.45–1.52 µs      | 1.001–1.004 |
  | Sum, rounds of 10 ms | 823–846 ns   | 871–900 ns        | 1.059–1.065 |
  | Read of one number   | 0.42–0.46 ns | 2.99–3.20 ns      | 6.6–7.1     |

  The read returns a fractional number for every input. With one array,
  benk measured 0 heap bytes per call. Rotating the arrays with either
  counter cost 16 heap bytes per call across both sample times.

- **Feedback that variants share.** V8 keeps the type feedback of a call
  site with its function's code, which every closure of that function
  shares. Variants that a script makes from one function, one for each
  class, are each timed through call sites that have seen every class.
  [`benchmarks/own-source.ts`](benchmarks/own-source.ts) reads 1,000 fields
  through readers of 6 classes: with calls from one function, and with a
  [`compiledCopy()`](#variants-from-one-function) of it for each class.
  Each range covers all six classes in three runs of the packed bundle on
  an Apple M2 Pro with Node 26.13.0. The ratio compares the shared
  function's fastest round with the copy's for the same class in that run.

  | Rounds of | A copy for each class | One function | Ratio     |
  | --------- | --------------------- | ------------ | --------- |
  | 1 ms      | 369–401 ns            | 775–927 ns   | 2.04–2.37 |
  | 10 ms     | 371–393 ns            | 368–394 ns   | 0.98–1.01 |

  At 10 ms, the fastest rounds were close. The last two classes still
  showed two modes with the shared function in all three runs. For each
  class, 44 of 52 rounds had a median below 400 ns and the other 8 had a
  median above 830 ns. The fastest round alone hides that difference.

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
  shows the tiers, and benk notes the rounds before Turbofan's code took
  over, as [Rounds that changed](#rounds-that-changed) describes.

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

## Development

[`AGENTS.md`](AGENTS.md) has the guidelines for changing benk, and the checks
to run.

## License

[MIT](LICENSE)
