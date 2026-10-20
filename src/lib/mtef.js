/**
 * MathType's equation format (MTEF v5, MathType 4 and later) to a small tree.
 * The bytes come from an OLE object's "Equation Native" stream; layout per
 * Design Science's MTEF 5 spec, as also implemented by the MIT-licensed
 * `mathtype` Ruby gem.
 */

const OPT_NUDGE = 0x08;
const OPT_CHAR_EMBELL = 0x01;
const OPT_CHAR_ENC_CHAR_8 = 0x04;
const OPT_CHAR_ENC_CHAR_16 = 0x10;
const OPT_CHAR_ENC_NO_MTCODE = 0x20;
const OPT_LINE_NULL = 0x01;
const OPT_LINE_LSPACE = 0x04;
const OPT_LP_RULER = 0x02;
const COLOR_CMYK = 0x01;
const COLOR_NAME = 0x04;

/** Stand-alone formatting records: read past, not kept. */
const FORMATTING = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

/**
 * @typedef {{type: 'line', items: Node[], isNull?: boolean}} Line
 * @typedef {{type: 'char', code: number, typeface: number, embells: number[]}} Char
 * @typedef {{type: 'tmpl', selector: number, variation: number, options: number, items: Node[]}} Tmpl
 * @typedef {{type: 'pile', halign: number, items: Node[]}} Pile
 * @typedef {{type: 'matrix', rows: number, cols: number, items: Node[]}} Matrix
 * @typedef {Line|Char|Tmpl|Pile|Matrix} Node
 */

/**
 * @param {Uint8Array} stream  The whole "Equation Native" stream.
 * @returns {{inline: boolean, items: Node[]}}
 */
export function parseEquationNative(stream) {
    if (!(stream instanceof Uint8Array) || stream.length < 2) throw new Error('Empty Equation Native stream.');
    const headerSize = stream[0] | (stream[1] << 8);
    return parseMtef(stream.subarray(headerSize));
}

/**
 * @param {Uint8Array} bytes  MTEF, starting at its version byte.
 * @returns {{inline: boolean, items: Node[]}}
 */
export function parseMtef(bytes) {
    const r = new Reader(bytes);
    const version = r.u8();
    if (version !== 5) throw new Error(`MTEF version ${version} is not supported (only 5).`);
    r.u8(); // platform
    r.u8(); // product
    r.u8(); // product version
    r.u8(); // product subversion
    r.cstring(); // application key, e.g. "DSMT7"
    const inline = r.u8() === 1;
    return { inline, items: readList(r) };
}

/** Records until END, structural ones kept. */
function readList(r) {
    const items = [];
    for (;;) {
        if (r.done()) throw new Error('MTEF ended inside an object list.');
        const node = readRecord(r);
        if (node === END) return items;
        if (node) items.push(node);
    }
}

const END = Symbol('end');

function readRecord(r) {
    const type = r.u8();
    if (type === 0) return END;
    if (type >= 100) {
        r.skip(r.mtUint());
        return null;
    }
    if (FORMATTING.has(type)) {
        readFormatting(r, type);
        return null;
    }

    const options = r.u8();
    if (options & OPT_NUDGE) readNudge(r);

    switch (type) {
        case 1: { // LINE
            if (options & OPT_LINE_LSPACE) r.u16();
            if (options & OPT_LP_RULER) readRuler(r);
            if (options & OPT_LINE_NULL) return { type: 'line', items: [], isNull: true };
            return { type: 'line', items: readList(r) };
        }
        case 2: { // CHAR
            const typeface = r.i8() + 128;
            const code = options & OPT_CHAR_ENC_NO_MTCODE ? 0 : r.u16();
            if (options & OPT_CHAR_ENC_CHAR_8) r.u8();
            else if (options & OPT_CHAR_ENC_CHAR_16) r.u16();
            const embells = options & OPT_CHAR_EMBELL
                ? readList(r).filter((n) => n.type === 'embell').map((n) => n.embell)
                : [];
            return { type: 'char', code, typeface, embells };
        }
        case 3: { // TMPL
            const selector = r.u8();
            const first = r.u8();
            const variation = first & 0x80 ? (first & 0x7F) | (r.u8() << 8) : first;
            const tmplOptions = r.u8();
            return { type: 'tmpl', selector, variation, options: tmplOptions, items: readList(r) };
        }
        case 4: { // PILE
            const halign = r.u8();
            r.u8(); // valign
            if (options & OPT_LP_RULER) readRuler(r);
            return { type: 'pile', halign, items: readList(r) };
        }
        case 5: { // MATRIX
            r.u8(); // valign
            r.u8(); // h_just
            r.u8(); // v_just
            const rows = r.u8();
            const cols = r.u8();
            // Two bits per partition line, one more line than rows/cols.
            r.skip(Math.floor((rows + 4) / 4));
            r.skip(Math.floor((cols + 4) / 4));
            return { type: 'matrix', rows, cols, items: readList(r) };
        }
        case 6: // EMBELL
            return { type: 'embell', embell: r.u8() };
        default:
            throw new Error(`Unknown MTEF record type ${type}.`);
    }
}

function readFormatting(r, type) {
    switch (type) {
        case 7: readRuler(r); break;
        case 8: r.mtUint(); r.u8(); break; // FONT_STYLE_DEF
        case 9: { // SIZE
            const select = r.u8();
            if (select === 101) r.u16();
            else if (select === 100) { r.u8(); r.u16(); }
            else r.u8();
            break;
        }
        case 15: r.mtUint(); break; // COLOR
        case 16: { // COLOR_DEF
            const options = r.u8();
            r.skip(options & COLOR_CMYK ? 8 : 6);
            if (options & COLOR_NAME) r.cstring();
            break;
        }
        case 17: r.mtUint(); r.cstring(); break; // FONT_DEF
        case 18: readEqnPrefs(r); break;
        case 19: r.cstring(); break; // ENCODING_DEF
        default: break; // 10-14: typesize, no payload
    }
}

function readNudge(r) {
    const dx = r.u8();
    const dy = r.u8();
    if (dx === 128 && dy === 128) { r.u16(); r.u16(); }
}

function readRuler(r) {
    const stops = r.u8();
    r.skip(stops * 3);
}

/** Dimension arrays are nibble-packed: a unit nibble, digits, then 0xF. */
function readEqnPrefs(r) {
    r.u8(); // options
    const nibbleArray = () => {
        const count = r.u8();
        let high = true;
        let byte = 0;
        const nibble = () => {
            if (high) byte = r.u8();
            const n = high ? byte >> 4 : byte & 0x0F;
            high = !high;
            return n;
        };
        for (let i = 0; i < count; i++) {
            nibble(); // unit
            while (nibble() !== 0x0F) { /* digits */ }
        }
    };
    nibbleArray(); // sizes
    nibbleArray(); // spaces
    const styles = r.u8();
    for (let i = 0; i < styles; i++) {
        if (r.u8() !== 0) r.u8();
    }
}

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.pos = 0;
    }
    done() { return this.pos >= this.bytes.length; }
    u8() {
        if (this.pos >= this.bytes.length) throw new Error('MTEF truncated.');
        return this.bytes[this.pos++];
    }
    i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
    u16() { const lo = this.u8(); return lo | (this.u8() << 8); }
    mtUint() { const b = this.u8(); return b < 0xFF ? b : this.u16(); }
    skip(n) {
        if (this.pos + n > this.bytes.length) throw new Error('MTEF truncated.');
        this.pos += n;
    }
    cstring() {
        let s = '';
        for (let b = this.u8(); b !== 0; b = this.u8()) s += String.fromCharCode(b);
        return s;
    }
}
