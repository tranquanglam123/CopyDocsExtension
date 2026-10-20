/**
 * Minimal reader for OLE compound files (CFB), the container an embedded
 * Office object (oleObjectN.bin) is stored in. Read-only, streams by name.
 */

const SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const END_OF_CHAIN = 0xFFFFFFFE;
const FREE_SECT = 0xFFFFFFFF;
const STREAM = 2;
const ROOT = 5;

/** Guards a corrupt chain from looping forever. */
const MAX_CHAIN = 1 << 20;

/**
 * @param {Uint8Array} bytes
 * @param {string} name  Stream name, e.g. "Equation Native".
 * @returns {Uint8Array|null} The stream's bytes, or null when it is absent.
 */
export function readCfbStream(bytes, name) {
    if (!isCfb(bytes)) throw new Error('Not an OLE compound file.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (offset) => view.getUint32(offset, true);

    const sectorSize = 1 << view.getUint16(0x1E, true);
    const miniSectorSize = 1 << view.getUint16(0x20, true);
    const miniCutoff = u32(0x38);
    const sectorOffset = (sector) => (sector + 1) * sectorSize;

    // The FAT's own sectors: 109 in the header, the rest in DIFAT sectors.
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
        const s = u32(0x4C + i * 4);
        if (s !== FREE_SECT) fatSectors.push(s);
    }
    let difat = u32(0x44);
    for (let n = u32(0x48); n > 0 && difat < END_OF_CHAIN; n--) {
        const base = sectorOffset(difat);
        for (let i = 0; i < sectorSize / 4 - 1; i++) {
            const s = u32(base + i * 4);
            if (s !== FREE_SECT) fatSectors.push(s);
        }
        difat = u32(base + sectorSize - 4);
    }
    const perSector = sectorSize / 4;
    const fatEntry = (sector) => {
        const fs = fatSectors[Math.floor(sector / perSector)];
        return fs === undefined ? END_OF_CHAIN : u32(sectorOffset(fs) + (sector % perSector) * 4);
    };

    const chain = (start, next) => {
        const out = [];
        for (let s = start; s < END_OF_CHAIN && out.length < MAX_CHAIN; s = next(s)) out.push(s);
        return out;
    };
    const readChain = (start, size) => {
        const out = new Uint8Array(size);
        let pos = 0;
        for (const s of chain(start, fatEntry)) {
            if (pos >= size) break;
            const off = sectorOffset(s);
            const take = Math.min(sectorSize, size - pos, bytes.length - off);
            if (take <= 0) break;
            out.set(bytes.subarray(off, off + take), pos);
            pos += take;
        }
        return out;
    };

    // Directory: 128-byte entries along the directory chain.
    const dirSectors = chain(u32(0x30), fatEntry);
    const entries = [];
    for (const s of dirSectors) {
        const base = sectorOffset(s);
        for (let i = 0; i < sectorSize / 128; i++) {
            const e = base + i * 128;
            if (e + 128 > bytes.length) break;
            const nameLength = view.getUint16(e + 0x40, true);
            let entryName = '';
            for (let c = 0; c + 2 < nameLength; c += 2) entryName += String.fromCharCode(view.getUint16(e + c, true));
            entries.push({ name: entryName, type: bytes[e + 0x42], start: u32(e + 0x74), size: u32(e + 0x78) });
        }
    }

    const root = entries.find((e) => e.type === ROOT);
    const entry = entries.find((e) => e.type === STREAM && e.name === name);
    if (!entry || !root) return null;
    if (entry.size >= miniCutoff) return readChain(entry.start, entry.size);

    // Small streams live in the mini stream, chained through the mini FAT.
    const miniStream = readChain(root.start, root.size);
    const miniFat = readChain(u32(0x3C), u32(0x40) * sectorSize);
    const miniView = new DataView(miniFat.buffer);
    const miniNext = (s) => (s * 4 + 4 <= miniFat.length ? miniView.getUint32(s * 4, true) : END_OF_CHAIN);
    const out = new Uint8Array(entry.size);
    let pos = 0;
    for (const s of chain(entry.start, miniNext)) {
        if (pos >= entry.size) break;
        const off = s * miniSectorSize;
        const take = Math.min(miniSectorSize, entry.size - pos);
        out.set(miniStream.subarray(off, off + take), pos);
        pos += take;
    }
    return out;
}

/** @param {Uint8Array} bytes */
export function isCfb(bytes) {
    return bytes instanceof Uint8Array && bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}
