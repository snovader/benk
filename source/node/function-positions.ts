// Where functions start, as V8 places them, which the traced run of
// `--v8-report` reads of each variant's `run`, so that the report can tie
// what V8 did to the variant. Node's inspector gives a function's position,
// which is the one that V8's code log gives it, from 0 rather than 1: an
// arrow function's, a method's and a named function's were the same in both.
import type { Runtime, Session } from 'node:inspector/promises';
import type { SourcePosition } from './v8-trace.ts';

type RemoteObject = Runtime.RemoteObject;

/** The global that the inspector reaches the functions by, while it reads them */
const FUNCTIONS = 'benk.functions';

/** The inspector's group of the objects that it hands out, to release them */
const OBJECT_GROUP = 'benk';

/**
 * Where each function starts, in its script, with a line and column from 1,
 * or null for one without a position, as a builtin. A bound function has
 * its target's position. In a Node built without the inspector, each is
 * null.
 *
 * It enables the inspector's debugger for as long as it reads them, as
 * `recordSourceMaps()` does, after the run's measurement.
 */
export async function functionPositions(
    functions: ReadonlyArray<() => unknown>
): Promise<Array<SourcePosition | null>> {
    if (!process.features.inspector || functions.length === 0) {
        return functions.map(() => null);
    }

    // Imported here, as the module throws in a Node without the inspector
    const inspector = await import('node:inspector/promises');
    const session = new inspector.Session();
    const urls = new Map<string, string>();
    const global = globalThis as Record<symbol, unknown>;
    const key = Symbol.for(FUNCTIONS);

    session.on('Debugger.scriptParsed', ({ params }) => {
        urls.set(params.scriptId, params.url);
    });
    session.connect();
    global[key] = functions;
    try {
        // V8 lists the scripts that it has before it answers
        await session.post('Debugger.enable');
        const reader = new PositionReader(session, urls);

        return await reader.positions(
            `globalThis[Symbol.for(${JSON.stringify(FUNCTIONS)})]`,
            functions.length
        );
    } finally {
        delete global[key];
        await session.post('Runtime.releaseObjectGroup', {
            objectGroup: OBJECT_GROUP
        });
        await session.post('Debugger.disable');
        session.disconnect();
    }
}

/** Reads positions of functions through an inspector's session */
class PositionReader {
    readonly #session: Session;
    readonly #urls: ReadonlyMap<string, string>;

    constructor(session: Session, urls: ReadonlyMap<string, string>) {
        this.#session = session;
        this.#urls = urls;
    }

    /** The positions of the functions of an array that an expression gives */
    async positions(
        expression: string,
        length: number
    ): Promise<Array<SourcePosition | null>> {
        const { result } = await this.#session.post('Runtime.evaluate', {
            expression,
            objectGroup: OBJECT_GROUP
        });
        const items = await this.#properties(result.objectId);

        const positions: Array<SourcePosition | null> = [];
        for (let i = 0; i < length; i++) {
            const item = items.find(({ name }) => name === String(i));
            positions.push(await this.#position(item?.value?.objectId));
        }

        return positions;
    }

    /**
     * A function's position, from its internal property
     * `[[FunctionLocation]]`, or its target's, as a bound function has
     * `[[TargetFunction]]` in its place
     */
    async #position(
        objectId: string | undefined
    ): Promise<SourcePosition | null> {
        if (objectId == null) {
            return null;
        }

        const { internalProperties = [] } = await this.#session.post(
            'Runtime.getProperties',
            { objectId, ownProperties: true }
        );
        const internal = (name: string): RemoteObject | undefined =>
            internalProperties.find(property => property.name === name)?.value;

        const location = internal('[[FunctionLocation]]')?.value as
            | { scriptId: string; lineNumber: number; columnNumber: number }
            | undefined;
        if (location != null) {
            const url = this.#urls.get(location.scriptId);
            return url == null
                ? null
                : {
                      url,
                      line: location.lineNumber + 1,
                      column: location.columnNumber + 1
                  };
        }

        const target = internal('[[TargetFunction]]')?.objectId;
        return target == null ? null : this.#position(target);
    }

    async #properties(
        objectId: string | undefined
    ): Promise<ReadonlyArray<{ name: string; value?: { objectId?: string } }>> {
        if (objectId == null) {
            return [];
        }

        const { result } = await this.#session.post('Runtime.getProperties', {
            objectId,
            ownProperties: true
        });
        return result;
    }
}
