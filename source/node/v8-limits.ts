// Turbofan's limits on inlining, which V8's report and its check compare
// functions' bytecode with. They're V8's flags, read from V8 rather than
// written down here: their defaults differ between versions, as the small
// function's is 27 B in V8 13.6 and 30 B in 14.6, and a script can set them.
import { execFile } from 'node:child_process';
import type { InliningLimits } from '#source/core/types';

/** V8's flag of each limit */
export const INLINING_FLAGS: Readonly<Record<keyof InliningLimits, string>> = {
    maxInlinedBytecodeSize: 'max-inlined-bytecode-size',
    maxInlinedBytecodeSizeCumulative: 'max-inlined-bytecode-size-cumulative',
    maxInlinedBytecodeSizeSmall: 'max-inlined-bytecode-size-small'
};

/** Enough for the help of V8's flags, of about 300 KB in Node 26 */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Turbofan's limits, as Node with these flags has them: `node --v8-options`
 * prints each flag with its value, in the place of its default, which is
 * the value that a flag before it sets, as `--max-inlined-bytecode-size=600`
 * printed 600 in Node 24.22.3, 26.13.0 and 27.0.0-alpha. Node exits after
 * printing them, before it loads a module that another flag names.
 *
 * Flags that a script sets as it runs, with `v8.setFlagsFromString()`,
 * aren't seen. `NODE_OPTIONS` can't set them: Node rejects them there.
 *
 * @returns null if V8 didn't print one of the flags, as when it renamed it.
 * @throws {Error} If Node fails to print them.
 */
export async function readInliningLimits(
    flags: readonly string[] = process.execArgv
): Promise<InliningLimits | null> {
    const help = await new Promise<string>((resolve, reject) => {
        execFile(
            process.execPath,
            [...flags, '--v8-options'],
            { maxBuffer: MAX_BUFFER },
            (error, stdout) => {
                if (error == null) {
                    resolve(stdout);
                } else {
                    reject(
                        new Error(
                            "Expected node --v8-options to print V8's flags",
                            {
                                cause: error
                            }
                        )
                    );
                }
            }
        );
    });

    return parseInliningLimits(help);
}

/**
 * The limits in what `node --v8-options` prints, as
 * `type: int  default: --max-inlined-bytecode-size=460`, or null if it
 * hasn't each of them
 */
export function parseInliningLimits(help: string): InliningLimits | null {
    const value = (flag: string): number | undefined => {
        const match = new RegExp(String.raw`default: --${flag}=(\d+)\b`).exec(
            help
        );
        return match == null ? undefined : Number(match[1]);
    };

    const maxInlinedBytecodeSize = value(INLINING_FLAGS.maxInlinedBytecodeSize);
    const maxInlinedBytecodeSizeCumulative = value(
        INLINING_FLAGS.maxInlinedBytecodeSizeCumulative
    );
    const maxInlinedBytecodeSizeSmall = value(
        INLINING_FLAGS.maxInlinedBytecodeSizeSmall
    );
    if (
        maxInlinedBytecodeSize == null ||
        maxInlinedBytecodeSizeCumulative == null ||
        maxInlinedBytecodeSizeSmall == null
    ) {
        return null;
    }

    return {
        maxInlinedBytecodeSize,
        maxInlinedBytecodeSizeCumulative,
        maxInlinedBytecodeSizeSmall
    };
}
