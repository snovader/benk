/**
 * The orders in which rounds run `count` variants, numbered from 0, one order
 * a round, as a balanced Latin square: over the rotation's rounds, every
 * variant takes every position equally often, and runs straight after every
 * other variant equally often. A variant's time can depend on its position,
 * and on what ran just before it, as when another variant leaves garbage to
 * collect or code that V8 tiers up, so each of these then affects every
 * variant alike.
 *
 * It's Williams' design: the first order is 0, 1, count − 1, 2, count − 2, …,
 * and each next one adds 1 to every variant's number, modulo `count`. With an
 * odd count, the orders run in reverse as well, so a rotation has `count`
 * rounds for an even count and `2 × count` for an odd one, and 1 for a single
 * variant. Running whole rotations makes the balance exact; across processes,
 * a script can start each process at another round of it.
 *
 * @throws {RangeError} If the count isn't a positive integer.
 */
export function rotation(count: number): number[][] {
    if (!Number.isInteger(count) || count < 1) {
        throw new RangeError(
            `Expected a positive integer count of variants, got ${count}`
        );
    }
    if (count === 1) {
        return [[0]];
    }

    const first = firstOrder(count);
    const orders = first.map((_, shift) =>
        first.map(variant => (variant + shift) % count)
    );

    return count % 2 === 0
        ? orders
        : [...orders, ...orders.map(order => order.toReversed())];
}

/** 0, 1, count − 1, 2, count − 2, …: each step a different distance away */
function firstOrder(count: number): number[] {
    const order = [0];
    for (let position = 1; position < count; position++) {
        const step = Math.ceil(position / 2);
        order.push(position % 2 === 1 ? step : count - step);
    }

    return order;
}
