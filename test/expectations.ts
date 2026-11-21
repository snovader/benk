// Expectations that hypotes' matchers don't have, for the tests to share
import { expect } from 'hypotes';

/**
 * Expects a value that is neither null nor undefined, and returns it as
 * such, which a matcher doesn't narrow its type to
 */
export function expectPresent<T>(value: T, message?: string): NonNullable<T> {
    if (value === null || value === undefined) {
        expect.fail(message ?? `Expected a value, but got ${String(value)}`);
    }

    return value;
}

/**
 * Expects two times to agree, apart from the rounding of the fake clock's
 * sums: within a billionth of the expected one, which `toBeCloseTo`'s
 * digits after the point don't say for times of any size
 */
export function expectClose(
    actual: number,
    expected: number,
    message?: string
): void {
    const difference = Math.abs(actual - expected);

    expect(
        difference,
        message ?? `${actual} ≉ ${expected}`
    ).toBeLessThanOrEqual(expected * 1e-9);
}
