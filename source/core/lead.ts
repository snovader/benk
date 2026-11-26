import { quantile } from './statistics.ts';
import type { Lead, LeadReason, Summary } from './types.ts';

/** The time per call from which a group leads with the median, in nanoseconds */
export const LONG_CALL = 1000;

/**
 * The bytes per call from which a group leads with the median, on the heap
 * and in array buffers together
 */
export const ALLOCATING_CALL = 1024;

/** The lead of a group's ratios, and why */
export interface LeadChoice {
    readonly lead: Lead;
    readonly reason: LeadReason;
}

/** What `chooseLead()` reads of each variant */
export interface LeadInput {
    readonly summary: Summary;
    readonly heapBytes: number | null;
    readonly arrayBufferBytes: number | null;
}

/**
 * Chooses the statistic that a group's ratios compare, unless the group set
 * one. The rounds of a short call that allocates little differ mostly by
 * load from other processes and interrupts, which only slow them, so the
 * fastest round comes closest to the call's own cost, and varies the least.
 * A long call's round holds few calls, and an allocating call's rounds
 * collect garbage in some rounds and not in others: their fastest round
 * leaves out work that the calls cause, which the median includes, and the
 * spread shows how much it varies. So a group leads with the median when any
 * of its variants' median call takes 1 µs or more, or allocates 1 KiB or
 * more, and with the fastest otherwise. Every variant of a group is compared
 * by the same statistic.
 *
 * The bytes of array buffers count with the heap's. A buffer's contents
 * live outside V8's heap, but the rounds of a call that allocates them vary
 * as much as those of a call that allocates on the heap, or more: in Node
 * 26, the median round of a call that allocated a 1 KiB `Float64Array` took
 * 1.8 to 2.6 times its fastest, and 1.2 to 1.3 times for an array of 1 KiB
 * on the heap, as the README measures.
 */
export function chooseLead(
    set: Lead | 'auto',
    variants: readonly LeadInput[]
): LeadChoice {
    if (set !== 'auto') {
        return { lead: set, reason: 'set' };
    }
    if (variants.some(({ summary }) => summary.median >= LONG_CALL)) {
        return { lead: 'median', reason: 'long calls' };
    }
    if (variants.some(allocates)) {
        return { lead: 'median', reason: 'allocating calls' };
    }

    return { lead: 'fastest', reason: 'short calls' };
}

/** Whether a variant's call allocates `ALLOCATING_CALL` bytes or more */
function allocates({ heapBytes, arrayBufferBytes }: LeadInput): boolean {
    return (heapBytes ?? 0) + (arrayBufferBytes ?? 0) >= ALLOCATING_CALL;
}

/**
 * A variant's ratio to the reference by the lead: its fastest round's to
 * the reference's fastest, or the median of its sorted per-round ratios to
 * the reference
 */
export function ratioByLead(
    lead: Lead,
    summary: Summary,
    reference: Summary,
    sortedRatios: ArrayLike<number>
): number | null {
    const ratio =
        lead === 'fastest'
            ? summary.fastest / reference.fastest
            : quantile(sortedRatios, 0.5);

    // A reference round shorter than one clock tick can read zero.
    return Number.isFinite(ratio) ? ratio : null;
}
