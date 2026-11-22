# Code and design guidelines

These repository guidelines apply when designing, implementing, reviewing, and
refactoring code. Use judgment about tradeoffs; existing code is evidence of
intent, not a requirement to preserve every detail.

## Responsibilities and architecture

- Give each function, class, and module a clear scope of responsibility.
  For example, `rotation.ts` orders the rounds, `statistics.ts` summarizes
  samples, `timed-variant.ts` runs a variant's loops, `measure.ts` measures
  groups, `report.ts` formats results, and `node/runtime.ts` creates Node's
  timer loops.
- Search for existing implementations and related abstractions before adding
  code. Always consider reusability and where behavior belongs. Keep a helper
  local when its responsibility is local; share it when it has a coherent role
  across callers.
- Use classes for encapsulated state, identity, lifecycle, or meaningful behavior.
  Use functions for stateless operations. Caches can own mutable state when that
  is part of their purpose.
- Introduce interfaces at meaningful boundaries or useful substitution points.
  Inject dependencies directly through constructors or callbacks, as the
  core takes a `Runtime`. A hypothetical future implementation alone needs
  stronger justification.
- A stable domain-facing API can justify a thin delegating wrapper, provided its
  purpose is clear. Do not remove such a wrapper merely because it delegates.
- Respect package exports. Keep dependencies consistent with the responsibility
  of the package and consider their runtime costs.

## Functions and readability

- Prefer small, focused functions with intentional names. A single caller does
  not prevent extraction: naming a meaningful operation or clarifying its scope
  is sufficient. Avoid arbitrary function-length limits.
- Use whitespace deliberately to separate logical sections within a function,
  such as preparation, computation, side effects, and the result. Keep closely
  related statements together.
- Avoid chained calls with large inline function bodies. Extract substantial
  callbacks into named functions or methods so the overall operation stays easy
  to follow.
- Review adjacent multiline calls and deeply nested expressions for readability.
  Use blank lines between distinct steps and meaningful intermediate variables
  where they clarify the sequence. Preserve efficient execution when restructuring
  expressions; readability does not require extra copies or traversals.
- Use domain terminology consistently. Comments should explain non-obvious
  constraints, algorithms, units, external behavior, or implementation tradeoffs.
  Document public contracts where callers need that information.

## Idioms

The shared lint configuration allows each of these, so that the code says
what it means rather than what a rule asks for. The linter doesn't choose
between them: the author does.

- Check a nullable string, number or boolean by its truthiness, as
  `if (value)`, rather than by `!== undefined` or `=== true`. Do so only
  where '' and 0 are to be treated as missing too, or can't occur.
  Otherwise compare, as the command line's options do, where `--json ''`
  and `--rounds ''` are mistakes to report rather than options left out.
- Check for a missing value with `== null` or `!= null`, which match both
  null and undefined. Compare strictly only where the two mean different
  things, as in `timerResolutionOf()`, whose cache holds null for a clock
  that read no time, and has undefined for a runtime not yet estimated.
- Write a default for a nullable value as `a ?? b`. Use `a || b` only where
  '' or 0 is meant to be replaced too, and then say so.
- Sort or reverse a copy that the function owns in place, with `.sort()` or
  `.reverse()`, as `sortedCopy()` does. `toSorted()` and `toReversed()` are
  for an array that's someone else's, as the rotation's orders, which it
  returns both forwards and reversed.
- Give a regular expression a `u` flag only where the pattern needs one: to
  match by code point beyond the Basic Multilingual Plane, or for `\p{…}`.
  `--filter` compiles its pattern with one, since group names are any text.
- Index an array where the index is known to be in range, as
  `lines[lines.length - 1]`. Use `.at()` where it may not be, and handle
  the undefined.
- Fix what the linter reports rather than suppressing it. Where the rewrite
  that a rule asks for reads worse, keep the code, with a disable directive
  that gives the reason. A directive that no longer suppresses anything is
  itself an error.

## Encapsulation and API design

- Prefer private fields and method-style accessors, especially when access
  performs computation, validation, caching, or other logic. Use `readonly` where
  the field should not be reassigned. This preference can evolve when language
  features offer a compelling improvement.
- Make construction and conversion intentional, using named factories or
  conversion methods where they clarify semantics.
- Make call sites understandable. Use options objects for related configuration.
- Use types to express contracts, including identifiers, units, and supported
  representations where useful. Follow the existing explicit return types and
  type-only imports at API boundaries.
- Decide failure behavior explicitly for each API. Consider possible inputs,
  who calls it, and how its output will be consumed before choosing exceptions,
  missing values, non-finite results, or fallbacks. Document and test that choice.
- Validate external data at appropriate boundaries and establish internal
  invariants deliberately. Avoid silently replacing invalid results with plausible
  values unless that is the intended contract.
- Don't recheck at runtime what documented usage or the types already
  guarantee. Enforce correctness at the boundary that owns it, such as the
  API's contract.

## Measurement

- benk times variants against each other in one process. What it reports
  has to hold up against V8's confounds, so each choice that affects a
  measurement says why in the code, and the README describes what a user
  sees: the rotation of the variants' order, the A/A copy, calibration and
  warm-up, the lead statistic, the modes, the interval, the heap bytes, and
  the timer's resolution.
  Where benk departs from tafla's harness, which it was extracted from, say
  why, as `heap.ts` does for counting the median heap sample.
- A variant's timer loop is its own, compiled from a unique source, so that
  its call site and type feedback aren't shared. Keep everything that isn't
  the variant's call out of the loop: setup, teardown, awaits of sync
  variants, and checks. A sync variant's loop never awaits, and the rounds
  of sync variants run straight after one another.
- Statistics are of the rounds, as samples, and summaries are samples too,
  such as the median, rather than averages. A heuristic, such as the
  detection of two modes, names its thresholds as constants and documents
  what they were chosen against.
- Results are plain data that `JSON.stringify` writes as they are. A change
  to a field of `RunResult` changes `schema`.
- Report a confound that benk can't remove in the README's known confounds,
  with the measurement that shows it.

## Runtimes

- `source/core` runs on any JavaScript runtime and takes a `Runtime`, which
  creates timer loops and counts heap bytes. What's particular to a host
  stays in its runtime's folder: Node's, such as `node:v8`, in
  `source/node`, and d8's, such as its `version()`, in `source/d8`. The
  core compiles no strings: Node's and d8's runtimes compile their loops
  with `new Function`, which Workers forbid. oxlint rejects imports of
  Node's modules in the core and in d8's runtime.
- A runtime records what it knows of the process that changes what's
  timed in its description's `processState`, as `source/node/runtime.ts`
  records benk's own loading from TypeScript source, whose type stripping
  detaches an ArrayBuffer in Node 26. Record facts that the runtime knows,
  rather than states that it infers.
- `source/index.ts` is the Node entry point, `benk`, which passes Node's
  runtime to the core. `source/core.ts` is the core's entry point,
  `benk/core`, which loads none of Node's modules and requires a runtime.
  It exports what `benk` does, apart from what needs Node.
  `source/d8.ts` is d8's entry point, `benk/d8`, which exports its runtime
  and its `bench()`, and loads none of Node's modules: a script in d8 takes
  the rest from `benk/core`. A runtime for browsers or Workers would be an
  entry point of its own too.
- `source/benk-d8.ts` is the entry point of the package's command,
  `benk-d8`, which runs a script in d8 from Node, so that `--v8-report` can
  run it again in d8, as d8 can't start a process. `source/node/d8-command.ts`
  reads its command line, which is d8's, and `source/node/traced-run.ts`
  runs d8 with the trace flags. package.json's `bin` names its source, and
  `publishConfig`'s its bundle.
- The command line is the core's, in `command-line.ts`: the options, which
  `arguments.ts` reads as Node's `parseArgs()` does, since `node:util` is
  Node's, and the run that prints the description and the tables. Each
  entry point's `bench()` passes its host's arguments and output, and
  decides what each option means there. An option that a host can't carry
  out is an error there, as `--v8-report` is in d8's `bench()`, which
  `benk-d8` carries out instead, and a new option needs a decision for each
  host, which the README's table for d8 records. `benk-d8` passes d8 the
  script's options, but those that it carries out.
- The source of the timer loops is the core's, in `timer-source.ts`, since
  a runtime that can't compile a string writes its loops from it at build
  time. A change to it changes what every runtime times.

## CPU, memory, and measurement

- Design for CPU and memory efficiency from the outset. Avoid unnecessary copies,
  allocations, loops, conversions, and repeated computation.
- Balance performance against complexity and clarity. When the tradeoff is
  uncertain, run the code, measure representative workloads, and evaluate the
  result. Do not rely solely on intuition about what should be faster.
- For performance changes, compare actual behavior before and after, including
  relevant CPU or memory costs. Preserve correctness and public contracts.
  Report the workload, results, and limitations of the measurement; distinguish
  measured results from expectations.

## Refactoring and language evolution

- Before undertaking a broader refactor discovered during a task, propose it to
  the user. Show concrete evidence of the problem, the proposed design, affected
  scope, benefits, and costs. Wait for a decision before implementing that broader
  change. Routine local structuring within the agreed task can proceed.
- Consider current language and platform capabilities. A built-in may replace
  custom code or a dependency when supported by the project's target runtimes and
  compatible with the required behavior. Preserve the intent of the design while
  evaluating better ways to express it.

## Tests

- Test the public API, not the implementation. Assert what a caller can
  observe, such as the results it gets and the errors raised. Do not assert
  private state or which code path ran.
- Write tests with hypotes, which has Vitest's `describe`, `it` and `expect`
  on Node's test runner. Compare objects and arrays with `toStrictEqual`,
  since `toEqual` takes a field that is undefined for one that is missing,
  which differ in results that are written as JSON. A matcher doesn't narrow
  a type, so take a value that may be null through `expectPresent`, of
  `test/expectations.ts`.
- Import what a test tests by the name that the package exports it under,
  `benk`, `benk/core` or `benk/d8`, which `yarn test:dist` runs on the bundle. Import what the package
  doesn't export by its private path, as `test/statistics.test.ts` imports
  `#source/core/statistics`, which suits modules without state.
- Time with the fake runtime of `test/fake-runtime.ts`, whose clock moves only
  when a fake call spends time, and whose heap grows only when one
  allocates, so that a test knows what a measurement should report. Tests of
  `NodeRuntime` and `D8Runtime` check only what doesn't vary between runs.
  The tests that run in d8 need `d8` on the PATH, and are skipped without
  it. CI doesn't install it, so run them locally after changing d8's
  runtime, `benk-d8`, or the traced run. The tests of what `benk-d8` does
  with d8's output run `test/fake-d8.ts` in its place, through a shell
  script, which Windows can't run, so CI runs them on Linux and macOS.
- Prefer property tests, with `it.prop` of `hypotes/fast-check`, as for the
  rotation's balance and the consistency of summaries with their samples.
  Check that a property test fails against code that loses the property, as
  the rotation's tests fail against alternating order.
- Compare floats with a tolerance where the fake clock's sums round, with
  `expectClose`, and with `toBe` otherwise, which compares with `Object.is`.
- Use meaningful test names and keep grouping shallow. Add `describe` blocks
  when they organize related behavior, rather than repeating the file's identity.
- The parsers of `--v8-report` read V8's traces and code log, whose formats
  V8 changes between versions. Their tests read what traced runs of
  `test/fixtures/v8/bench.ts` wrote, which `test/fixtures/v8/capture.ts`
  captures on the Node that runs it. Capture it on each version of Node
  that the parsers are checked against, as the README lists them, and on a
  new version before saying that they read it.
- The tests of the report's source maps read the traced run of a bundle,
  `test/fixtures/v8/bundled/bench.mjs`, and its map, which
  `test/fixtures/v8/bundled/capture.ts` bundles with rolldown and traces.
  Run it from the repository's root, as the bundle's comments name its
  modules from there. The bundle and its map are committed with the
  traced run, since the tests read the map from the file.
- The tests of the report in d8 read the traced run of
  `test/fixtures/v8/d8/bench.mjs`, the bundle of `test/fixtures/v8/bench.ts`
  with `benk/d8` in it, which `test/fixtures/v8/d8/capture.ts` bundles and
  traces on the d8 on the PATH, as `benk-d8` does. Capture it on each
  version of d8 that the parsers are checked against. d8 names a script by
  its path, which the parsers turn into its file's URL.
- Run the relevant code and checks, and state anything that could not be run.

## Package and runtime

- The package supports the versions of Node that `engines` names. Use a
  built-in only when every one of them has it.
- Node runs the TypeScript source as it is, by stripping its types, so use
  only erasable syntax, and import relative modules with their `.ts`
  extensions.
- The tests, examples and benchmarks run with
  `node --no-strip-types --import @snovader/node-hooks/register`, whose
  hook strips the types with oxc. Node's own stripping of a module as
  large as benk's source detaches an ArrayBuffer, which in Node 26 slows
  code that reads typed arrays for the rest of the process, as the README
  measures. `--no-strip-types` came in Node 24.12, and hypotes needs Node
  24.13.1, so developing benk needs Node 24.13.1 or later, although the
  published bundle runs on what `engines` names. The tests add
  `--enable-source-maps`, so that a stack trace points
  at the TypeScript lines. `prepack`'s `node scripts/require-yarn.ts` keeps
  Node's own stripping. Import a module in a parent directory by a private path of
  package.json's `imports`, as `#source/core/types`, rather than by `../`,
  and an entry point by its name, `benk`, `benk/core` or `benk/d8`. oxlint checks each of these.
- Name TypeScript and JavaScript files and their folders in kebab-case, as
  `timed-variant.ts`, whatever they export. oxlint checks the files' names.
- `yarn build` bundles the entry points and `benk-d8` into `dist/` with
  rolldown, and tsc writes the declarations. In this repository, the
  package's exports name the source, or the bundle with the `benk-dist`
  condition, which `yarn test:dist` runs the tests on; the published
  package's, in `publishConfig`, name the bundle.
- benk has no runtime dependencies. Adding one needs strong justification.

## Documentation

- `README.md` is for the package's users, and is published with it. It says
  what benk is and when to use it, how to start, what the package exports,
  how to read a result, and which confounds stay in one. This file is for
  those who change the package. Keep each fact in one of them.
- Lead with the common case. The quick start is the shortest path to a
  first table: install, a benchmark script, `node bench.ts`, and its output.
  Introduce what only some users need where they need it, as `setup` comes
  with the variants whose calls need fresh input, not with the first script.
- Give steps in the order that a reader takes them. Name the file that a
  sample goes in, and show a command's output where it tells the reader
  that the step worked.
- Say why, not only what. A reader chooses between benk and a general
  harness, so say what each choice costs. Don't retell the source: describe
  what a caller does and sees.
- Write short sentences, one idea in each. Two sentences read better than
  one with a chain of clauses, and a list or a table better than a long
  sentence of alternatives. Use numbered steps for a procedure, and a table
  for what a reader looks up. Leave out emoji, praise of the package, and
  sections that say nothing a reader needs.
- State only what was checked. Run every sample and command before
  committing it, on the built package, in a project outside the repository.
  A measurement names its machine, its version of Node, and the runs that
  it's from. Say in the pull request what was run, and what wasn't.
- A change to what the package exports changes the README in the same
  change: a new export, a command-line option, a column or a note of the
  table, or a field of the results. `test/readme.test.ts` compares the
  README's lists of exports and of command-line options with the package's.
  Where the README names things one by one, add such a check for the list.
- Link to Node's and V8's documentation for what they document, rather than
  restating it.
- Don't add other documentation files, such as a changelog or a
  contributing guide, unless asked to.
- oxfmt ignores Markdown, so wrap prose at 80 columns by hand, and align
  the columns of tables.

## Formatting

- Follow the formatter and compiler configurations. oxfmt sets four-space
  indentation, single quotes, semicolons, no trailing commas, and contextual
  line widths. Intentional whitespace and readable structure still require
  judgment after automatic formatting.
- The configurations extend the shared ones of `@snovader/tsconfig` and
  `@snovader/oxc-config`, from the repository `snovader/tooling`. benk's
  own files keep only what's particular to benk: the paths that the tools
  ignore or check, the name that benk imports itself by, and in
  `oxlint.config.ts`, the shared rules for tests on hypotes, and the
  imports that it restricts, of parent directories, of entry points by
  their private paths, and of Node's modules in the core. Each has its
  comment. The shared base already turns off what benk used to turn
  off itself, such as awaits in loops and type assertions, so don't repeat
  its rules here. Change a setting that suits any project in the shared
  package instead.
- `@snovader/oxc-config` loads only on Node 26 or later, so the format and
  lint checks need Node 26, while the tests run on each version that
  `engines` names.

## Repository commands

- Run the checks from the repository's root: `yarn format:check`,
  `yarn lint:check`, `yarn typecheck`, `yarn test`, and `yarn test:dist`,
  which builds the package and runs the tests on the bundle.
  `.github/workflows/ci.yml` runs the same checks in CI.
- Yarn installs a version of a package only a day after it's published.
  `.yarnrc.yml` exempts `hypotes` and `@snovader/*`, the owner's own
  packages, with `npmPreapprovedPackages`, so that a new version of one
  installs on the day it's published.
- Pack and publish only with Yarn, which replaces the exports with those of
  `publishConfig`, as `scripts/require-yarn.ts` checks.
