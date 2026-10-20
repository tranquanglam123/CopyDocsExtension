/**
 * Minimal ZIP reader for .docx: the central directory, STORE and DEFLATE.
 * Inflation is DecompressionStream, a global in Chrome and in Node alike.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The EOCD record sits in the last 22 bytes plus at most a 64KB comment. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;

export class MiniUnzip {

    /** @param {Uint8Array} bytes */
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        /** @type {Map<string, {method: number, compressedSize: number, localOffset: number}>} */
        this.entries = this._readDirectory();
    }

    /** @returns {string[]} */
    names() {
        return [...this.entries.keys()];
    }

    /** @param {string} name @returns {boolean} */
    has(name) {
        return this.entries.has(name);
    }

    /**
     * @param {string} name
     * @returns {Promise<Uint8Array|null>} null when the archive has no such entry.
     */
    async read(name) {
        const entry = this.entries.get(name);
        if (!entry) return null;

        const { localOffset, compressedSize, method } = entry;
        if (this.view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
            throw new Error(`Corrupt ZIP: bad local header for ${name}.`);
        }
        // The local header's own name/extra lengths can differ from the
        // central directory's, so the data offset is read here.
        const nameLength = this.view.getUint16(localOffset + 26, true);
        const extraLength = this.view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + nameLength + extraLength;
        const data = this.bytes.subarray(start, start + compressedSize);

        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }

    /** @param {string} name @returns {Promise<string|null>} */
    async readText(name) {
        const data = await this.read(name);
        return data === null ? null : new TextDecoder('utf-8').decode(data);
    }

    _readDirectory() {
        const { view, bytes } = this;
        const floor = Math.max(0, bytes.length - EOCD_SEARCH_BYTES);
        let eocd = -1;
        for (let i = bytes.length - 22; i >= floor; i--) {
            if (view.getUint32(i, true) === EOCD_SIGNATURE) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('Not a ZIP archive: no end-of-central-directory record.');

        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        const entries = new Map();
        const decoder = new TextDecoder('utf-8');

        for (let i = 0; i < count; i++) {
            if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
                throw new Error('Corrupt ZIP: bad central directory entry.');
            }
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

            entries.set(name, { method, compressedSize, localOffset });
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
