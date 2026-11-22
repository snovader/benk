import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'hypotes';
import * as benk from 'benk';
import * as core from 'benk/core';
import * as d8 from 'benk/d8';

// The README names the package's exports and the command line's options one
// by one, which a change to either would leave behind: these compare its
// tables with the package. Its samples are run by hand, as AGENTS.md says.
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');

/** The first table after a heading of the README, up to the blank line that ends it */
function tableAfter(heading: string): string {
    const at = readme.indexOf(`${heading}\n`);
    expect(at, `Expected the README to have the heading "${heading}"`).not.toBe(-1);

    const from = readme.indexOf('\n|', at);
    return readme.slice(from, readme.indexOf('\n\n', from));
}

/** What `pattern` captures first in each of its matches */
function captures(text: string, pattern: RegExp): string[] {
    return Array.from(text.matchAll(pattern), match => match[1]);
}

describe('README', () => {
    it('describes each export of benk', () => {
        const described = captures(tableAfter('## API'), /^\| `(\w+)/gm);

        expect(described.sort()).toStrictEqual(Object.keys(benk).sort());
    });

    it('names each export of benk that benk/core leaves out', () => {
        const named = captures(tableAfter('### Runtimes'), /^\| `(\w+)/gm);
        const exported = new Set(Object.keys(core));
        const leftOut = Object.keys(benk).filter(name => !exported.has(name));

        expect(named.sort()).toStrictEqual(leftOut.sort());
        expect(Object.keys(core).filter(name => !(name in benk))).toStrictEqual([]);
    });

    it('describes each export of benk/d8', () => {
        const described = captures(tableAfter('### d8'), /^\| `(\w+)/gm);

        expect(described.sort()).toStrictEqual(Object.keys(d8).sort());
    });

    it('describes each option of the command line', () => {
        // An option with a value, as `--rounds <n>`, has a space after its name
        const options = new Set(captures(tableAfter('### Options'), /^\| `(--[a-z-]+ ?)/gm));
        const args = Array.from(options).flatMap(option =>
            option.endsWith(' ') ? [option.trimEnd(), '7'] : [option]
        );

        // parseOptions() rejects an option that it doesn't have, and each of
        // those that it has changes a default that no other does
        const defaults = new Map(Object.entries(benk.parseOptions([])));
        const unchanged = Object.entries(benk.parseOptions(args))
            .filter(([name, value]) => Object.is(value, defaults.get(name)))
            .map(([name]) => name);

        expect(unchanged).toStrictEqual([]);
    });
});
