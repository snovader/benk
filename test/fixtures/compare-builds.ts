// A benchmark script for the tests of `compareBuilds()` across processes,
// which the fake runtime times: it compares the builds of `builds/`, whose
// `sum` takes half as long in head, and records the order in which each run
// made the builds' groups, a line for each run, in the file that
// `BUILDS_ORDER` names.
import { appendFileSync } from 'node:fs';
import { compareBuilds } from 'benk';
import { FakeRuntime } from '#test/fake-runtime';
import type * as Builds from './builds/base.ts';

type Build = typeof Builds;

const runtime = new FakeRuntime();
const order: string[] = [];

await compareBuilds(
    (build: Build) => {
        order.push(build.NAME);

        return [
            {
                name: 'calls',
                variants: [
                    runtime.variant('sum', build.NANOSECONDS.sum),
                    runtime.variant('sort', build.NANOSECONDS.sort)
                ]
            }
        ];
    },
    { runtime }
);

appendFileSync(process.env.BUILDS_ORDER ?? '', `${order.join(' ')}\n`);
