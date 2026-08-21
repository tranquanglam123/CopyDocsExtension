/**
 * MiniZip — Minimal ZIP file creator using only browser APIs.
 * Produces valid ZIP files without any external dependencies.
 * Supports STORE (no compression) which is fine for XML/text content.
 */
export class MiniZip {

    constructor() {
        /** @type {Array<{ name: string, data: Uint8Array, date: Date }>} */
        this.files = [];
    }

    /**
     * Add a file to the archive.
     * @param {string} name     Path inside the ZIP (e.g. "word/document.xml")
     * @param {string|Uint8Array} content  File content (string or bytes)
     */
    addFile(name, content) {
        const data = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;
        this.files.push({ name, data, date: new Date() });
    }

    /**
     * Generate the ZIP as a Blob.
     * @returns {Blob}
     */
    toBlob() {
        const parts = [];
        const centralDir = [];
        let offset = 0;

        for (const file of this.files) {
            const nameBytes = new TextEncoder().encode(file.name);
            const crc = MiniZip._crc32(file.data);
            const dosTime = MiniZip._dosDateTime(file.date);

            // ── Local file header ─────────────────────────────
            const localHeader = new ArrayBuffer(30 + nameBytes.length);
            const lv = new DataView(localHeader);
            lv.setUint32(0, 0x04034b50, true);   // signature
            lv.setUint16(4, 20, true);            // version needed
            lv.setUint16(6, 0, true);             // flags
            lv.setUint16(8, 0, true);             // compression: STORE
            lv.setUint16(10, dosTime.time, true);  // mod time
            lv.setUint16(12, dosTime.date, true);  // mod date
            lv.setUint32(14, crc, true);           // CRC-32
            lv.setUint32(18, file.data.length, true); // compressed size
            lv.setUint32(22, file.data.length, true); // uncompressed size
            lv.setUint16(26, nameBytes.length, true); // filename length
            lv.setUint16(28, 0, true);             // extra field length
            new Uint8Array(localHeader).set(nameBytes, 30);

            // ── Central directory entry ───────────────────────
            const centralEntry = new ArrayBuffer(46 + nameBytes.length);
            const cv = new DataView(centralEntry);
            cv.setUint32(0, 0x02014b50, true);   // signature
            cv.setUint16(4, 20, true);            // version made by
            cv.setUint16(6, 20, true);            // version needed
            cv.setUint16(8, 0, true);             // flags
            cv.setUint16(10, 0, true);            // compression
            cv.setUint16(12, dosTime.time, true);
            cv.setUint16(14, dosTime.date, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, file.data.length, true);
            cv.setUint32(24, file.data.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);            // extra field length
            cv.setUint16(32, 0, true);            // comment length
            cv.setUint16(34, 0, true);            // disk number
            cv.setUint16(36, 0, true);            // internal attrs
            cv.setUint32(38, 0, true);            // external attrs
            cv.setUint32(42, offset, true);       // local header offset
            new Uint8Array(centralEntry).set(nameBytes, 46);

            parts.push(new Uint8Array(localHeader));
            parts.push(file.data);
            centralDir.push(new Uint8Array(centralEntry));

            offset += localHeader.byteLength + file.data.length;
        }

        // ── End of central directory ──────────────────────────
        const centralStart = offset;
        let centralSize = 0;
        for (const entry of centralDir) {
            parts.push(entry);
            centralSize += entry.length;
        }

        const eocd = new ArrayBuffer(22);
        const ev = new DataView(eocd);
        ev.setUint32(0, 0x06054b50, true);        // signature
        ev.setUint16(4, 0, true);                  // disk number
        ev.setUint16(6, 0, true);                  // disk with central dir
        ev.setUint16(8, this.files.length, true);  // entries on this disk
        ev.setUint16(10, this.files.length, true); // total entries
        ev.setUint32(12, centralSize, true);       // central dir size
        ev.setUint32(16, centralStart, true);      // central dir offset
        ev.setUint16(20, 0, true);                 // comment length
        parts.push(new Uint8Array(eocd));

        return new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }

    /**
     * CRC-32 (ISO 3309 / ITU-T V.42) calculation.
     * @param {Uint8Array} data
     * @returns {number}
     */
    static _crc32(data) {
        if (!MiniZip._crcTable) {
            const table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) {
                    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                }
                table[n] = c;
            }
            MiniZip._crcTable = table;
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
            crc = MiniZip._crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * Convert a JS Date to DOS date/time format.
     * @param {Date} date
     * @returns {{ time: number, date: number }}
     */
    static _dosDateTime(date) {
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
            date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        };
    }
}
