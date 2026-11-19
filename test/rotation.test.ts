import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import { rotation } from 'benk';

/** How often each variant takes each position over the orders */
function positionCounts(orders: number[][], count: number): number[][] {
    const counts = Array.from({ length: count }, () => new Array<number>(count).fill(0));
    for (const order of orders) {
        for (const [position, variant] of order.entries()) {
            counts[variant][position]++;
        }
    }

    return counts;
}

/** How often each variant runs straight after each other variant */
function successorCounts(orders: number[][]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const order of orders) {
        for (let position = 1; position < order.length; position++) {
            const pair = `${order[position - 1]}→${order[position]}`;
            counts.set(pair, (counts.get(pair) ?? 0) + 1);
        }
    }

    return counts;
}

describe('rotation', () => {
    it('orders every variant once a round', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 24 }), count => {
                const expected = Array.from({ length: count }, (_, i) => i);
                for (const order of rotation(count)) {
                    assert.deepEqual(
                        order.toSorted((a, b) => a - b),
                        expected
                    );
                }
            })
        );
    });

    it('has count rounds for an even count, and twice as many for an odd one', () => {
        fc.assert(
            fc.property(fc.integer({ min: 2, max: 24 }), count => {
                assert.equal(rotation(count).length, count % 2 === 0 ? count : 2 * count);
            })
        );
        assert.deepEqual(rotation(1), [[0]]);
    });

    it('takes every variant through every position equally often', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 24 }), count => {
                const orders = rotation(count);
                const each = orders.length / count;
                for (const counts of positionCounts(orders, count)) {
                    assert.deepEqual(counts, new Array<number>(count).fill(each));
                }
            })
        );
    });

    it('runs every variant straight after every other equally often', () => {
        fc.assert(
            fc.property(fc.integer({ min: 2, max: 24 }), count => {
                const counts = successorCounts(rotation(count));
                const each = count % 2 === 0 ? 1 : 2;

                assert.equal(counts.size, count * (count - 1));
                for (const times of counts.values()) {
                    assert.equal(times, each);
                }
            })
        );
    });

    it('moves the middle of three variants, which alternating order leaves in place', () => {
        const middle = rotation(3).map(order => order.indexOf(1));
        assert.deepEqual(new Set(middle), new Set([0, 1, 2]));
    });

    it('rejects a count of variants that is not a positive integer', () => {
        for (const count of [0, -1, 1.5, Number.NaN, Infinity]) {
            assert.throws(() => rotation(count), RangeError);
        }
    });
});
