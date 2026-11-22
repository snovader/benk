import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'hypotes';
import * as benk from 'benk';
import * as core from 'benk/core';
import * as d8 from 'benk/d8';
import { D8_OPTION } from '#source/node/d8-command';
import { TRACE_FLAGS } from '#source/node/traced-run';

// The README names the package's exports and the command line's options one
// by one, in Node, in d8 and in benk-d8, which a change to either would
// leave behind: these compare its tables with the package. Its samples are run by hand, as
// AGENTS.md says.
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

/** The options of the command line that a table's first column names, each once */
function optionsNamed(table: string): string[] {
    const firstCells = captures(table, /^\| ([^|]+)\|/gm);
    const options = firstCells.flatMap(cell => captures(cell, /`(--[a-z\d-]+)/g));

    return Array.from(new Set(options)).sort();
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
        const options = new Set(captures(tableAfter('### Options'), /^\| `(--[a-z\d-]+ ?)/gm));
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

    it('says what each option of the command line does in d8', () => {
        expect(optionsNamed(tableAfter('#### Options in d8'))).toStrictEqual(
            optionsNamed(tableAfter('### Options'))
        );
    });

    it("names each of V8's flags of the traced run of --v8-report", () => {
        const at = readme.indexOf('### What the traced run changes\n');
        expect(at, 'Expected the README to say what the traced run changes').not.toBe(-1);

        const section = readme.slice(at, readme.indexOf('\n### ', at + 1));
        const named = new Set(captures(section, /`(--[a-z-]+)`/g));

        expect(TRACE_FLAGS.filter(flag => !named.has(flag))).toStrictEqual([]);
    });

    it("names benk-d8's own option, in the table of its command line", () => {
        const named = captures(tableAfter('### In d8'), /^\| `(--[a-z\d-]+=?)/gm);

        expect(named).toStrictEqual([D8_OPTION]);
    });
});
