// The source maps of the scripts that V8's traces name: where they place a
// bundle's positions, and what's left of a position when a map can't be read
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'hypotes';
import { fc, it } from 'hypotes/fast-check';
import {
    readSourceMapFile,
    readSourceMaps,
    ScriptSourceMap,
    type SourceMapFile
} from '#source/node/source-maps';
import type { SourcePosition } from '#source/node/v8-trace';
import { BENCH_URL, BUNDLE_URL, BUNDLED, REPOSITORY } from './v8-fixtures.ts';

/** A mapping: its column, and its source's index, line and column, from 0 */
type Segment = readonly [number, number, number, number];

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A number in a source map's base64 VLQ */
function vlq(value: number): string {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1;
    let text = '';
    do {
        const digit = rest & 31;
        rest >>>= 5;
        text += BASE64[rest > 0 ? digit | 32 : digit];
    } while (rest > 0);

    return text;
}

/** The `mappings` of a source map of each line's segments, sorted by column */
function encodeMappings(lines: ReadonlyArray<readonly Segment[]>): string {
    const previous = [0, 0, 0];
    const encoded: string[] = [];

    for (const segments of lines) {
        let column = 0;
        const fields: string[] = [];
        for (const [generated, ...original] of segments) {
            fields.push(
                vlq(generated - column) +
                    original.map((value, i) => vlq(value - previous[i])).join('')
            );
            column = generated;
            previous.splice(0, 3, ...original);
        }
        encoded.push(fields.join(','));
    }

    return encoded.join(';');
}

/** A source map of version 3 */
function sourceMap(
    sources: unknown[],
    lines: ReadonlyArray<readonly Segment[]>,
    more = {}
): object {
    return { version: 3, sources, names: [], mappings: encodeMappings(lines), ...more };
}

/** `function sum(values) {}`, with mappings of `sum` and `(` to line 3 of the source */
const CODE = 'function sum(values) {}';
const LINE: readonly Segment[] = [
    [9, 0, 2, 16],
    [12, 0, 2, 19]
];

/** Writes files into a new temporary directory, and removes it after the test */
async function inDirectory(
    files: Record<string, string>,
    test: (directory: string) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'benk-'));
    try {
        for (const [name, text] of Object.entries(files)) {
            await writeFile(join(directory, name), text);
        }
        await test(directory);
    } finally {
        await rm(directory, { recursive: true });
    }
}

function urlOf(directory: string, name: string): string {
    return pathToFileURL(join(directory, name)).href;
}

describe('the source map of the bundled fixture', () => {
    const SUM = urlOf(join(REPOSITORY, BUNDLED), 'sum.ts');
    const BENCH = urlOf(join(REPOSITORY, BUNDLED), 'bench.ts');
    const at = (line: number, column: number): SourcePosition => ({
        url: BUNDLE_URL,
        line,
        column
    });

    it('places positions of the bundle in its sources', async () => {
        const maps = await readSourceMaps([BUNDLE_URL]);

        // Where V8 places `sum`, at its parameters, and where it deoptimized
        expect(maps.original(at(4, 13))).toStrictEqual({ url: SUM, line: 6, column: 20 });
        expect(maps.original(at(6, 29))).toStrictEqual({ url: SUM, line: 8, column: 32 });
        // A variant's `run`, in the other source
        expect(maps.original(at(23, 9))).toStrictEqual({ url: BENCH, line: 20, column: 33 });
        expect(maps.unread()).toStrictEqual(new Map());
    });

    it('keeps a position that no mapping of its line comes at or before', async () => {
        const maps = await readSourceMaps([BUNDLE_URL]);

        // The import of benk, which the bundle wrote, and `export {}`, whose
        // line has no mappings, after a line that has
        expect(maps.original(at(1, 1))).toStrictEqual(at(1, 1));
        expect(maps.original(at(35, 1))).toStrictEqual(at(35, 1));
    });

    it("keeps the positions of scripts that aren't files, or name no source map", async () => {
        const scripts = ['node:path', '', BENCH_URL];
        const maps = await readSourceMaps(scripts);

        for (const url of scripts) {
            expect(maps.original({ url, line: 2, column: 3 })).toStrictEqual({
                url,
                line: 2,
                column: 3
            });
        }
        expect(maps.unread()).toStrictEqual(new Map());
    });
});

describe('readSourceMaps', () => {
    const map = JSON.stringify(sourceMap(['source.ts'], [LINE]));

    it('reads a source map beside a script, and one inline, from the script', async () => {
        const inline = `data:application/json;base64,${Buffer.from(map).toString('base64')}`;
        const files = {
            'beside.mjs': `${CODE}\n//# sourceMappingURL=beside.mjs.map\n`,
            'beside.mjs.map': map,
            'inline.mjs': `${CODE}\n//# sourceMappingURL=${inline}\n`
        };

        await inDirectory(files, async directory => {
            const scripts = [urlOf(directory, 'beside.mjs'), urlOf(directory, 'inline.mjs')];
            const maps = await readSourceMaps(scripts);

            for (const url of scripts) {
                expect(maps.original({ url, line: 1, column: 14 })).toStrictEqual({
                    url: urlOf(directory, 'source.ts'),
                    line: 3,
                    column: 21
                });
            }
        });
    });

    it('reads the last comment that names a source map at the start of a line, in a script whose lines end in \\r\\n', async () => {
        const files = {
            'bundle.js': [
                '//# sourceMappingURL=other.map',
                CODE,
                '  //# sourceMappingURL=bundle.js.map',
                'const after = 1;',
                ''
            ].join('\r\n'),
            'bundle.js.map': JSON.stringify(sourceMap(['source.ts'], [[], LINE]))
        };

        await inDirectory(files, async directory => {
            const url = urlOf(directory, 'bundle.js');
            const maps = await readSourceMaps([url]);

            expect(maps.unread()).toStrictEqual(new Map());
            expect(maps.original({ url, line: 2, column: 10 })).toStrictEqual({
                url: urlOf(directory, 'source.ts'),
                line: 3,
                column: 17
            });
        });
    });

    it('reads no source map of the same text in a string, as V8 reads none', async () => {
        const files = {
            'library.mjs': [CODE, "const comment = '\\n//# sourceMappingURL=other.map';", ''].join(
                '\n'
            )
        };

        await inDirectory(files, async directory => {
            const url = urlOf(directory, 'library.mjs');
            const maps = await readSourceMaps([url]);

            expect(maps.unread()).toStrictEqual(new Map());
            expect(maps.original({ url, line: 1, column: 10 })).toStrictEqual({
                url,
                line: 1,
                column: 10
            });
        });
    });

    it('reads the source map of a script that V8 names by its path, as a CommonJS module', async () => {
        const files = {
            'bundle.cjs': `${CODE}\n//# sourceMappingURL=bundle.cjs.map\n`,
            'bundle.cjs.map': map
        };

        await inDirectory(files, async directory => {
            const path = join(directory, 'bundle.cjs');
            const maps = await readSourceMaps([path]);

            expect(maps.original({ url: path, line: 1, column: 13 })).toStrictEqual({
                url: urlOf(directory, 'source.ts'),
                line: 3,
                column: 20
            });
        });
    });

    it("keeps the positions of a script whose source map can't be read, and says why", async () => {
        const inline = 'data:application/json,%7Bnot%20JSON';
        const files = {
            'missing.mjs': `${CODE}\n//# sourceMappingURL=missing.mjs.map\n`,
            'malformed.mjs': `${CODE}\n//# sourceMappingURL=malformed.mjs.map\n`,
            'malformed.mjs.map': '{"version": 3,',
            'old.mjs': `${CODE}\n//# sourceMappingURL=old.mjs.map\n`,
            'old.mjs.map': JSON.stringify({ ...sourceMap(['source.ts'], [LINE]), version: 2 }),
            'remote.mjs': `${CODE}\n//# sourceMappingURL=https://example.com/remote.mjs.map\n`,
            'inline.mjs': `${CODE}\n//# sourceMappingURL=${inline}\n`
        };

        await inDirectory(files, async directory => {
            const names = [
                ...Object.keys(files).filter(name => name.endsWith('.mjs')),
                'deleted.mjs'
            ];
            const scripts = names.map(name => urlOf(directory, name));
            const maps = await readSourceMaps(scripts);
            const reasons = new Map(
                Array.from(maps.unread(), ([url, reason]) => [names[scripts.indexOf(url)], reason])
            );

            expect(Object.fromEntries(reasons)).toStrictEqual({
                'missing.mjs': "its source map, missing.mjs.map, couldn't be read (ENOENT)",
                'malformed.mjs': expect.stringMatching(
                    /^its source map, malformed\.mjs\.map, isn't one \(.*JSON/
                ),
                'old.mjs':
                    "its source map, old.mjs.map, isn't one (Expected a source map of version 3)",
                'remote.mjs':
                    "its source map, https://example.com/remote.mjs.map, couldn't be read (not a file or a data URL)",
                'inline.mjs': expect.stringMatching(/^its inline source map isn't one \(.*JSON/),
                'deleted.mjs': "it couldn't be read (ENOENT)"
            });
            for (const url of scripts) {
                expect(maps.original({ url, line: 1, column: 14 })).toStrictEqual({
                    url,
                    line: 1,
                    column: 14
                });
            }
        });
    });
});

describe('readSourceMaps of source maps read before', () => {
    const map = JSON.stringify(sourceMap(['source.ts'], [LINE]));

    it('takes the source map of a script that was deleted since, through JSON, as the traced run records it', async () => {
        const files = {
            'bundle.mjs': `${CODE}\n//# sourceMappingURL=bundle.mjs.map\n`,
            'bundle.mjs.map': map
        };

        await inDirectory(files, async directory => {
            const url = urlOf(directory, 'bundle.mjs');
            const recorded = JSON.stringify([[url, await readSourceMapFile(url)]]);
            for (const name of Object.keys(files)) {
                await rm(join(directory, name));
            }
            const read = JSON.parse(recorded) as Array<[string, SourceMapFile]>;
            const maps = await readSourceMaps([url], new Map(read));

            expect(maps.unread()).toStrictEqual(new Map());
            expect(maps.original({ url, line: 1, column: 14 })).toStrictEqual({
                url: urlOf(directory, 'source.ts'),
                line: 3,
                column: 21
            });
        });
    });

    it('takes the source map of a script that V8 names by its path, by the URL of its file', async () => {
        const files = {
            'bundle.cjs': `${CODE}\n//# sourceMappingURL=bundle.cjs.map\n`,
            'bundle.cjs.map': map
        };

        await inDirectory(files, async directory => {
            const url = urlOf(directory, 'bundle.cjs');
            const read = new Map([[url, await readSourceMapFile(url)]]);
            for (const name of Object.keys(files)) {
                await rm(join(directory, name));
            }
            const path = join(directory, 'bundle.cjs');
            const maps = await readSourceMaps([path], read);

            expect(maps.unread()).toStrictEqual(new Map());
            expect(maps.original({ url: path, line: 1, column: 13 })).toStrictEqual({
                url: urlOf(directory, 'source.ts'),
                line: 3,
                column: 20
            });
        });
    });

    it('keeps the reason of a script read before, and reads the scripts that were not', async () => {
        const files = {
            'other.mjs': `${CODE}\n//# sourceMappingURL=other.mjs.map\n`,
            'other.mjs.map': map
        };

        await inDirectory(files, async directory => {
            const deleted = urlOf(directory, 'deleted.mjs');
            const other = urlOf(directory, 'other.mjs');
            const read = new Map([[deleted, await readSourceMapFile(deleted)]]);
            const maps = await readSourceMaps([deleted, other], read);

            expect(maps.unread()).toStrictEqual(
                new Map([[deleted, "it couldn't be read (ENOENT)"]])
            );
            expect(maps.original({ url: other, line: 1, column: 14 })).toStrictEqual({
                url: urlOf(directory, 'source.ts'),
                line: 3,
                column: 21
            });
        });
    });
});

describe('ScriptSourceMap', () => {
    const BASE = new URL('file:///C:/project/dist/bench.mjs.map');
    const original = (sources: unknown[], more = {}): SourcePosition | undefined =>
        new ScriptSourceMap(sourceMap(sources, [LINE], more), BASE).original({
            url: 'file:///C:/project/dist/bench.mjs',
            line: 1,
            column: 10
        });

    it("resolves the sources from the map's URL, after its sourceRoot", () => {
        expect(original(['../source/sum.ts'])?.url).toBe('file:///C:/project/source/sum.ts');
        expect(original(['sum.ts'], { sourceRoot: 'source' })?.url).toBe(
            'file:///C:/project/dist/source/sum.ts'
        );
        expect(original(['sum.ts'], { sourceRoot: '/project/source/' })?.url).toBe(
            'file:///C:/project/source/sum.ts'
        );
    });

    it('resolves the paths of Windows, with backslashes or a drive, as some tools write them', () => {
        expect(original(['..\\source\\sum.ts'])?.url).toBe('file:///C:/project/source/sum.ts');
        expect(original(['D:\\shared\\sum.ts'])?.url).toBe('file:///D:/shared/sum.ts');
        expect(original(['sum.ts'], { sourceRoot: 'D:\\shared\\' })?.url).toBe(
            'file:///D:/shared/sum.ts'
        );
    });

    it('places nothing in a source that is null, as of code that a bundler wrote', () => {
        expect(original([null])).toBeUndefined();
    });

    it("reads an index map's sections", () => {
        const payload = {
            version: 3,
            sections: [{ offset: { line: 1, column: 0 }, map: sourceMap(['sum.ts'], [LINE]) }]
        };

        expect(
            new ScriptSourceMap(payload, BASE).original({ url: '', line: 2, column: 13 })
        ).toStrictEqual({
            url: 'file:///C:/project/dist/sum.ts',
            line: 3,
            column: 20
        });
    });

    it('rejects what is not a source map of version 3', () => {
        for (const payload of [null, [], {}, { version: 2, sources: [], mappings: '' }]) {
            expect(() => new ScriptSourceMap(payload, BASE)).toThrow(TypeError);
        }
    });

    // Up to 5 lines of up to 4 mappings each, sorted by column, in 2 sources
    const SOURCES = ['a.ts', 'b.ts'];
    const segment = fc.tuple(fc.integer({ min: 0, max: 30 }), fc.nat(1), fc.nat(20), fc.nat(30));
    const lines = fc.array(
        fc
            .uniqueArray(segment, { selector: ([column]) => column, maxLength: 4 })
            .map(segments => segments.toSorted(([a], [b]) => a - b)),
        { maxLength: 5 }
    );

    it.prop([lines])(
        "places a position after the last mapping of its line at or before it, as far after its source's, or nowhere without one",
        mapped => {
            const map = new ScriptSourceMap(sourceMap(SOURCES, mapped), BASE);

            for (let line = 0; line <= mapped.length; line++) {
                for (let column = 0; column <= 32; column++) {
                    const last = (mapped.at(line) ?? []).findLast(([start]) => start <= column);
                    const expected =
                        last == null
                            ? undefined
                            : {
                                  url: new URL(SOURCES[last[1]], BASE).href,
                                  line: last[2] + 1,
                                  column: last[3] + column - last[0] + 1
                              };

                    expect(
                        map.original({ url: '', line: line + 1, column: column + 1 })
                    ).toStrictEqual(expected);
                }
            }
        }
    );
});
