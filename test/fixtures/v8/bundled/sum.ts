// A module of the bundled benchmark. The bundle has its functions at other
// lines and columns than this file, after `bench.ts`'s imports and with its
// types and comments left out.

/** The sum of the values, which Turbofan inlines into a timer loop */
export function sum(values: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        total += values[i];
    }

    return total;
}

/** The mean of the values, which calls `sum` */
export function mean(values: readonly number[]): number {
    return sum(values) / values.length;
}
