// The build loaded first decides which call waits for its sibling to start
// measuring. The two processes thus start measuring the calls in opposite
// orders. Identical group names make a swap visible only in their ratios.
import { compareBuilds, type BuildName } from 'benk';
import { FakeRuntime } from '#test/fake-runtime';

const started = {
    base: Promise.withResolvers<void>(),
    head: Promise.withResolvers<void>()
};

async function compare(waitOn: BuildName, ratio: number): Promise<void> {
    const runtime = new FakeRuntime();
    let first = true;
    const other = waitOn === 'base' ? 'head' : 'base';

    await compareBuilds(
        async (build: { NAME: BuildName }) => {
            if (first && build.NAME === waitOn) {
                await started[other].promise;
            }
            first = false;
            const variant = runtime.variant(
                'call',
                build.NAME === 'base' ? 100 : 100 * ratio
            );
            return [
                {
                    name: 'group',
                    variants: [
                        { ...variant, setup: () => started[waitOn].resolve() }
                    ]
                }
            ];
        },
        {
            runtime,
            print: () => undefined,
            after: (_, result) =>
                console.log(
                    JSON.stringify([ratio, result.builds?.variants[0].ratios])
                )
        }
    );
}

await Promise.all([compare('base', 2), compare('head', 3)]);
