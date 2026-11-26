// What type feedback that variants share does to their times, against a
// call compiled from a source of its own for each: reads of 1,000 fields
// through readers of 6 classes, from one function literal, and from a
// `compiledCopy()` of it for each class. Run it with
// `node --no-strip-types --import @snovader/node-hooks/register
// benchmarks/own-source.ts`.
import { bench, compiledCopy, type Variant } from 'benk';

/** The fields that a call reads */
const FIELDS = 1000;

/** Reads a field of a typed array of one type */
interface Reader {
    get(index: number): number;
}

class Int8Reader implements Reader {
    readonly #fields = Int8Array.from({ length: FIELDS }, (_value, i) => i);

    get(index: number): number {
        return this.#fields[index];
    }
}

class Uint8Reader implements Reader {
    readonly #fields = Uint8Array.from({ length: FIELDS }, (_value, i) => i);

    get(index: number): number {
        return this.#fields[index];
    }
}

class Int16Reader implements Reader {
    readonly #fields = Int16Array.from({ length: FIELDS }, (_value, i) => i);

    get(index: number): number {
        return this.#fields[index];
    }
}

class Uint16Reader implements Reader {
    readonly #fields = Uint16Array.from({ length: FIELDS }, (_value, i) => i);

    get(index: number): number {
        return this.#fields[index];
    }
}

class Int32Reader implements Reader {
    readonly #fields = Int32Array.from({ length: FIELDS }, (_value, i) => i);

    get(index: number): number {
        return this.#fields[index];
    }
}

class Uint32Reader implements Reader {
    readonly #fields = Uint32Array.from({ length: FIELDS }, (_value, i) => i);

    get(index: number): number {
        return this.#fields[index];
    }
}

/**
 * More classes than the 4 that one of V8's call sites keeps apart, beyond
 * which it's megamorphic
 */
const READERS: Reader[] = [
    new Int8Reader(),
    new Uint8Reader(),
    new Int16Reader(),
    new Uint16Reader(),
    new Int32Reader(),
    new Uint32Reader()
];

/**
 * The call that reads every field of a reader, and combines them with XOR,
 * which keeps a small integer. Its `reader.get()` is one call site, which
 * every closure of this function shares, and a copy has to itself. It takes
 * the reader and the count as parameters, since a copy reads nothing of
 * this module.
 */
function reads(reader: Reader, fields: number): () => number {
    return () => {
        let hash = 0;
        for (let i = 0; i < fields; i++) {
            hash ^= reader.get(i);
        }

        return hash;
    };
}

/** Each class's reads from the one function, and from a copy of its own */
function variants(reader: Reader): Variant[] {
    const { name } = reader.constructor;

    return [
        { name: `${name}, own source`, run: compiledCopy(reads)(reader, FIELDS) },
        { name: `${name}, shared`, run: reads(reader, FIELDS) }
    ];
}

await bench([
    { name: `read ${FIELDS.toLocaleString('en-US')} fields`, variants: READERS.flatMap(variants) }
]);
