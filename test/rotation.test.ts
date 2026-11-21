import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
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
    it.prop([fc.integer({ min: 1, max: 24 })])('orders every variant once a round', count => {
        const expected = Array.from({ length: count }, (_, i) => i);
        for (const order of rotation(count)) {
            expect(order.toSorted((a, b) => a - b)).toStrictEqual(expected);
        }
    });

    it.prop([fc.integer({ min: 2, max: 24 })])(
        'has count rounds for an even count, and twice as many for an odd one',
        count => {
            expect(rotation(count)).toHaveLength(count % 2 === 0 ? count : 2 * count);
        }
    );

    it('has one round of a single variant', () => {
        expect(rotation(1)).toStrictEqual([[0]]);
    });

    it.prop([fc.integer({ min: 1, max: 24 })])(
        'takes every variant through every position equally often',
        count => {
            const orders = rotation(count);
            const each = orders.length / count;
            for (const counts of positionCounts(orders, count)) {
                expect(counts).toStrictEqual(new Array<number>(count).fill(each));
            }
        }
    );

    it.prop([fc.integer({ min: 2, max: 24 })])(
        'runs every variant straight after every other equally often',
        count => {
            const counts = successorCounts(rotation(count));
            const each = count % 2 === 0 ? 1 : 2;

            expect(counts.size).toBe(count * (count - 1));
            for (const times of counts.values()) {
                expect(times).toBe(each);
            }
        }
    );

    it('moves the middle of three variants, which alternating order leaves in place', () => {
        const middle = rotation(3).map(order => order.indexOf(1));
        expect(new Set(middle)).toStrictEqual(new Set([0, 1, 2]));
    });

    it('rejects a count of variants that is not a positive integer', () => {
        for (const count of [0, -1, 1.5, Number.NaN, Infinity]) {
            expect(() => rotation(count)).toThrow(RangeError);
        }
    });
});
