// The source maps of the scripts that V8's traces name, for `--v8-report`:
// they put a bundle's positions, as V8 has them, in the sources that it was
// bundled from. The traced run reads them before its `bench()` returns,
// while the scripts still exist, as a script that bundles a benchmark may
// delete its bundle once `bench()` returns, and records them for the
// process that reports it. Node's own `SourceMap` parses them.
import { readFile } from 'node:fs/promises';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourcePosition } from './v8-trace.ts';

/**
 * The comment that names a script's source map, as
 * `//# sourceMappingURL=bench.mjs.map`, which captures its URL. The last one
 * counts. V8 reads only a comment, and not the same text in a string, as of
 * a library that writes source maps. Without parsing the script, a line
 * that starts with the comment, as bundlers write it, tells it from one in
 * a string. One after code on its line, which V8 reads too, isn't read.
 */
const SOURCE_MAPPING_URL = /^[ \t]*\/\/[#@][ \t]+sourceMappingURL=(\S+)/gm;

/** A data URL, which captures its parameters and its data */
const DATA_URL = /^data:([^,]*),(.*)$/s;

/** A Windows path that starts with a drive, as `C:\project\source\sum.ts` */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/**
 * The source maps of scripts, by the URLs or paths that V8 names the scripts
 * by, and why those that couldn't be read couldn't
 */
export class SourceMaps {
    readonly #maps: ReadonlyMap<string, ScriptSourceMap>;
    readonly #unread: ReadonlyMap<string, string>;

    constructor(
        maps: ReadonlyMap<string, ScriptSourceMap>,
        unread: ReadonlyMap<string, string>
    ) {
        this.#maps = maps;
        this.#unread = unread;
    }

    /**
     * The position in the source that its script was compiled from, as the
     * script's source map has it. It's the position itself in a script
     * without a source map, or whose source map couldn't be read, and where
     * the map has no mapping on the position's line, at or before its
     * column, as in code that a bundler added.
     */
    original(position: SourcePosition): SourcePosition {
        return this.#maps.get(position.url)?.original(position) ?? position;
    }

    /**
     * Why each script that names a source map that couldn't be read has its
     * own positions, by the script's URL, as `it couldn't be read (ENOENT)`
     */
    unread(): ReadonlyMap<string, string> {
        return this.#unread;
    }
}

/**
 * A script's source map as it was read, before it's parsed: its text, or
 * why it couldn't be read, or null where the script isn't a file, as Node's
 * own modules, or names no source map
 */
export type SourceMapFile = SourceMapText | string | null;

/** The text of a script's source map */
export interface SourceMapText {
    /**
     * The map, as `its source map, bench.mjs.map,` or `its inline source
     * map`, for a reason that it isn't one
     */
    readonly named: string;
    /**
     * The URL that the sources are relative to: the source map's, or the
     * script's for a source map inline
     */
    readonly base: string;
    readonly text: string;
}

/**
 * Reads the source maps of scripts, by the URLs or paths that V8 names them
 * by, or takes them from those that were read before. A script's source map
 * is the file that its last `//# sourceMappingURL=` comment names, at the
 * start of a line, beside the script, or the map inline, as a data URL. A
 * script that isn't a file, as Node's own modules, or that names no source
 * map, keeps its positions.
 *
 * So does a script whose source map can't be read, and `unread()` says why.
 * This doesn't throw for it: the report is still of use with a bundle's
 * positions, as long as it says that they are.
 *
 * @param read The source maps that were read before, as the traced run
 * records them, by the URLs of the scripts' files, which aren't read again.
 */
export async function readSourceMaps(
    scripts: Iterable<string>,
    read: ReadonlyMap<string, SourceMapFile> = new Map()
): Promise<SourceMaps> {
    const unique = Array.from(new Set(scripts));
    const files = await Promise.all(
        unique.map(script => sourceMapFileOf(script, read))
    );

    const maps = new Map<string, ScriptSourceMap>();
    const unread = new Map<string, string>();
    for (let i = 0; i < unique.length; i++) {
        const file = files[i];
        const map = file == null ? undefined : parseSourceMap(file);
        if (typeof map === 'string') {
            unread.set(unique[i], map);
        } else if (map != null) {
            maps.set(unique[i], map);
        }
    }

    return new SourceMaps(maps, unread);
}

/**
 * Reads the text of a script's source map, as `readSourceMaps()` finds it,
 * or says why it couldn't, or returns null if the script names none, or
 * isn't a file
 */
export async function readSourceMapFile(
    script: string
): Promise<SourceMapFile> {
    const file = fileOf(script);
    if (file == null) {
        return null;
    }

    let code: string;
    try {
        code = await readFile(file, 'utf8');
    } catch (error) {
        return `it couldn't be read (${reasonOf(error)})`;
    }

    const reference = lastReference(code);
    if (reference == null) {
        return null;
    }

    // A data URL can be long, and says nothing of where the map is
    const named = reference.startsWith('data:')
        ? 'its inline source map'
        : `its source map, ${reference},`;
    try {
        const url = new URL(reference, file);
        const base = url.protocol === 'data:' ? file : url;
        return { named, base: base.href, text: await readReference(url) };
    } catch (error) {
        return `${named} couldn't be read (${reasonOf(error)})`;
    }
}

/**
 * A script's source map as it was read before, by the URL of its file, as
 * Node's inspector names a CommonJS module that V8 names by its path, or as
 * it's read now
 */
async function sourceMapFileOf(
    script: string,
    read: ReadonlyMap<string, SourceMapFile>
): Promise<SourceMapFile> {
    const url = fileOf(script)?.href;
    // Strictly, as null is of a script that was read, and names none
    const file = url == null ? undefined : read.get(url);

    return file === undefined ? readSourceMapFile(script) : file;
}

/** A script's source map, with its sources' URLs */
export class ScriptSourceMap {
    readonly #map: SourceMap;
    /** The URLs of the sources, by the names that the map gives them */
    readonly #sources = new Map<string, string>();

    /**
     * @param payload The source map, as JSON parses it.
     * @param base The URL that the sources are relative to: the source
     * map's, or the script's for a source map inline.
     * @throws {TypeError} If the payload isn't a source map of version 3,
     * or a source isn't a URL.
     */
    constructor(payload: unknown, base: URL) {
        if (!isSourceMap(payload)) {
            throw new TypeError('Expected a source map of version 3');
        }

        this.#map = new SourceMap(payload as SourceMapPayload);
        for (const [source, root] of sourcesOf(payload)) {
            this.#sources.set(source, sourceUrl(source, root, base));
        }
    }

    /**
     * The position in the source, or undefined where the map has no mapping
     * on the position's line, at or before its column. A bundler copies a
     * mapping's code from the source, so a column after the mapping's start
     * is as far after its start in the source, as Node's `findOrigin()`
     * takes it. Where the bundler renamed an identifier after the mapping,
     * or minified the code, the column is off by the difference in length:
     * telling it would take the bundle's code, and minified code can differ
     * anywhere. A segment of one field, which maps to no source, isn't told
     * apart by Node's `SourceMap`, which gives it the previous mapping's.
     */
    original({ line, column }: SourcePosition): SourcePosition | undefined {
        const entry = this.#map.findEntry(line - 1, column - 1);
        // The last mapping before the position, which can be on an earlier
        // line, in other code
        if (!('originalSource' in entry) || entry.generatedLine !== line - 1) {
            return undefined;
        }

        const source = this.#sources.get(entry.originalSource);
        if (source == null) {
            return undefined;
        }

        return {
            url: source,
            line: entry.originalLine + 1,
            column: entry.originalColumn + column - entry.generatedColumn
        };
    }
}

/** A source map, as far as it's checked before Node's `SourceMap` reads it */
interface SourceMapJson {
    readonly version: 3;
    readonly sourceRoot?: unknown;
    readonly sources?: unknown;
    /** The source maps of an index map, which Node's `SourceMap` reads too */
    readonly sections?: unknown;
}

function isSourceMap(value: unknown): value is SourceMapJson {
    return (
        typeof value === 'object' &&
        value != null &&
        'version' in value &&
        value.version === 3
    );
}

/**
 * Parses the text of a script's source map, or says why it isn't one, as a
 * reason that a script's positions are its own
 */
function parseSourceMap(
    file: SourceMapText | string
): ScriptSourceMap | string {
    if (typeof file === 'string') {
        return file;
    }

    try {
        return new ScriptSourceMap(JSON.parse(file.text), new URL(file.base));
    } catch (error) {
        return `${file.named} isn't one (${reasonOf(error)})`;
    }
}

/**
 * The URL of the file of a script that V8 names by its URL, as a module, or
 * by its path, as a CommonJS module, or undefined for another, as Node's
 * own modules and code compiled from a string
 */
function fileOf(script: string): URL | undefined {
    if (script.startsWith('file:')) {
        return new URL(script);
    }

    return isAbsolute(script) ? pathToFileURL(script) : undefined;
}

/**
 * The URL of the last `//# sourceMappingURL=` comment of a script, at the
 * start of a line
 */
function lastReference(code: string): string | undefined {
    let reference: string | undefined;
    for (const [, url] of code.matchAll(SOURCE_MAPPING_URL)) {
        reference = url;
    }

    return reference;
}

/**
 * The text of a source map in a file, or inline as a data URL, in base64 or
 * percent-encoded
 *
 * @throws {Error} If the file can't be read, or the URL is of another scheme.
 */
async function readReference(url: URL): Promise<string> {
    if (url.protocol === 'file:') {
        return readFile(url, 'utf8');
    }

    const data = url.protocol === 'data:' ? DATA_URL.exec(url.href) : null;
    if (data == null) {
        throw new Error('not a file or a data URL');
    }

    const [, parameters, encoded] = data;
    return parameters.endsWith(';base64')
        ? Buffer.from(encoded, 'base64').toString('utf8')
        : decodeURIComponent(encoded);
}

/**
 * The names of a source map's sources, with its `sourceRoot`, and those of
 * each map of an index map's sections. A source can be null, as of code that
 * a bundler wrote, which has no URL.
 */
function sourcesOf(map: SourceMapJson): Array<[string, string]> {
    const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
    const sources = Array.isArray(map.sources) ? map.sources : [];
    const own = sources
        .filter(source => typeof source === 'string')
        .map((source): [string, string] => [source, root]);
    const sections = Array.isArray(map.sections) ? map.sections : [];

    return [...own, ...sections.flatMap(sectionSources)];
}

/** The sources of an index map's section, as `{ offset, map }` */
function sectionSources(section: unknown): Array<[string, string]> {
    const map =
        typeof section === 'object' && section != null && 'map' in section
            ? section.map
            : undefined;

    return isSourceMap(map) ? sourcesOf(map) : [];
}

/**
 * A source's URL: its name after the map's `sourceRoot`, from the base, as
 * the specification of source maps resolves it, or of a Windows path with a
 * drive, which some tools write, and which a URL would read as a scheme
 *
 * @throws {TypeError} If it isn't a URL.
 */
function sourceUrl(source: string, root: string, base: URL): string {
    const rooted = root ? `${root.replace(/[\\/]?$/, '/')}${source}` : source;
    if (WINDOWS_PATH.test(rooted)) {
        return pathToFileURL(rooted, { windows: true }).href;
    }

    return new URL(rooted, base).href;
}

/** What an error says, briefly: a system error's code, as ENOENT, or its message */
function reasonOf(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    return 'code' in error && typeof error.code === 'string'
        ? error.code
        : error.message;
}
