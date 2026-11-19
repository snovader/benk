# Code and design guidelines

These repository guidelines apply when designing, implementing, reviewing, and
refactoring code. Use judgment about tradeoffs; existing code is evidence of
intent, not a requirement to preserve every detail.

## Responsibilities and architecture

- Give each function, class, and module a clear scope of responsibility.
  For example, `rotation.ts` orders the rounds, `statistics.ts` summarizes
  samples, `timedVariant.ts` runs a variant's loops, `measure.ts` measures
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
  warm-up, the lead statistic, the modes, the interval, and the heap bytes.
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
  creates timer loops and counts heap bytes. What's particular to Node, such
  as `new Function` and `node:v8`, stays in `source/node`. oxlint rejects
  imports of Node's modules in the core.
- `source/node/runtime.ts` detaches an ArrayBuffer as it's imported, so
  that typed-array code is timed alike however the process loaded its code,
  and records it in the runtime's `conditions`. A runtime that sets
  anything else in the process that changes what's timed records it there
  too.
- `source/index.ts` is the Node entry point, which passes Node's runtime to
  the core. A runtime for browsers or Workers would be an entry point of its
  own.

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
- Import what a test tests by the name that the package exports it under,
  `benk`, which `yarn test:dist` runs on the bundle. Import what the package
  doesn't export by its private path, as `test/statistics.test.ts` imports
  `#source/core/statistics`, which suits modules without state.
- Time with the fake runtime of `test/fakeRuntime.ts`, whose clock moves only
  when a fake call spends time, and whose heap grows only when one
  allocates, so that a test knows what a measurement should report. Tests of
  `NodeRuntime` check only what doesn't vary between runs.
- Prefer property tests, with fast-check, as for the rotation's balance and
  the consistency of summaries with their samples. Check that a property
  test fails against code that loses the property, as the rotation's tests
  fail against alternating order.
- Compare floats with a tolerance where the fake clock's sums round, and by
  their bits or with `Object.is` otherwise.
- Use meaningful test names and keep grouping shallow. Add `describe` blocks
  when they organize related behavior, rather than repeating the file's identity.
- Run the relevant code and checks, and state anything that could not be run.

## Package and runtime

- The package supports the versions of Node that `engines` names. Use a
  built-in only when every one of them has it.
- Node runs the TypeScript source as it is, by stripping its types, so use
  only erasable syntax, and import relative modules with their `.ts`
  extensions. Import a module in a parent directory by a private path of
  package.json's `imports`, as `#source/core/types`, rather than by `../`,
  and the entry point by its name, `benk`. oxlint checks each of these.
- `yarn build` bundles the entry point into `dist/` with rolldown, and tsc
  writes the declarations. In this repository, the package's exports name the
  source, or the bundle with the `benk-dist` condition, which
  `yarn test:dist` runs the tests on; the published package's, in
  `publishConfig`, name the bundle.
- benk has no runtime dependencies. Adding one needs strong justification.

## Formatting

- Follow the formatter and compiler configurations. oxfmt sets four-space
  indentation, single quotes, semicolons, no trailing commas, and contextual
  line widths. Intentional whitespace and readable structure still require
  judgment after automatic formatting.

## Repository commands

- Run the checks from the repository's root: `yarn format:check`,
  `yarn lint:check`, `yarn typecheck`, `yarn test`, and `yarn test:dist`,
  which builds the package and runs the tests on the bundle.
  `.github/workflows/ci.yml` runs the same checks in CI.
- Pack and publish only with Yarn, which replaces the exports with those of
  `publishConfig`, as `scripts/requireYarn.ts` checks.
