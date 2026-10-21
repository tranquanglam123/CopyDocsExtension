import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readCfbStream, isCfb } from '../src/lib/cfb.js';
import { parseMtef, parseEquationNative } from '../src/lib/mtef.js';
import { toOmml, toLinear, UnsupportedMath } from '../src/lib/math-render.js';

// ─── MTEF built by hand, record by record ───────────────────────────────────

const VARIABLE = 3 - 128;   // typeface byte: fnVARIABLE, stored as typeface - 128
const NUMBER = 8 - 128;
const u8 = (n) => [n & 0xFF];
const u16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];

const header = () => [5, 1, 0, 7, 4, ...Buffer.from('DSMT7\0'), 1];
const end = () => [0];
const ch = (c, typeface = VARIABLE) => [2, 0, ...u8(typeface), ...u16(c.codePointAt(0))];
const chars = (s, typeface) => [...s].flatMap((c) => ch(c, /\d/.test(c) ? NUMBER : typeface));
const line = (...items) => [1, 0, ...items.flat(), ...end()];
const nullLine = () => [1, 1];
const tmpl = (selector, variation, ...items) => [3, 0, selector, variation, 0, ...items.flat(), ...end()];
const eqn = (...items) => new Uint8Array([...header(), ...items.flat(), ...end()]);

const sup = (exp) => tmpl(28, 0, nullLine(), line(chars(exp)));
const frac = (num, den) => tmpl(11, 0, line(num), line(den));

describe('parseMtef', () => {

    test('reads characters, templates and slots', () => {
        const eq = parseMtef(eqn(line(ch('x'), sup('2'))));
        assert.equal(eq.inline, true);
        const [l] = eq.items;
        assert.equal(l.type, 'line');
        assert.deepEqual(l.items.map((n) => n.type), ['char', 'tmpl']);
        assert.equal(l.items[1].selector, 28);
        assert.equal(l.items[1].items[0].isNull, true);
    });

    test('skips formatting records it does not keep', () => {
        // FULL size (10), FONT_DEF (17), then the line.
        const bytes = eqn([10], [17, 1, ...Buffer.from('Times New Roman\0')], line(ch('y')));
        assert.equal(toLinear(parseMtef(bytes)), 'y');
    });

    test('reads past a 28-byte OLE header in Equation Native', () => {
        const stream = new Uint8Array([28, 0, ...new Array(26).fill(0), ...eqn(line(ch('z')))]);
        assert.equal(toLinear(parseEquationNative(stream)), 'z');
    });

    test('refuses other MTEF versions and truncated input', () => {
        assert.throws(() => parseMtef(new Uint8Array([3, 0, 0, 0, 0, 0, 0])), /version 3/);
        assert.throws(() => parseMtef(eqn(line(ch('x'))).subarray(0, 14)), /truncated|ended/);
    });
});

describe('toLinear', () => {

    test('powers use superscript digits, fractions bracket long parts', () => {
        assert.equal(toLinear(parseMtef(eqn(line(ch('x'), sup('2'), chars('−2xy'))))), 'x²−2xy');
        assert.equal(toLinear(parseMtef(eqn(line(frac(chars('x−1'), chars('y')))))), '(x−1)/y');
        assert.equal(toLinear(parseMtef(eqn(line(frac(chars('1'), chars('2')), ch('x'))))), '1/2x');
    });

    test('an exponent without superscript glyphs falls back to ^( )', () => {
        const eq = parseMtef(eqn(line(ch('x'), tmpl(28, 0, nullLine(), line(chars('ab'))))));
        assert.equal(toLinear(eq), 'x^(ab)');
    });

    test('fences, roots and accents', () => {
        const paren = tmpl(1, 3, line(chars('x+1')), ch('('), ch(')'));
        assert.equal(toLinear(parseMtef(eqn(line(paren, sup('2'))))), '(x+1)²');
        assert.equal(toLinear(parseMtef(eqn(line(tmpl(10, 0, line(chars('x+1'))))))), '√(x+1)');
        const hat = [2, 1, ...u8(VARIABLE), ...u16(0x41), 6, 0, 9, 0]; // A with embHAT
        assert.equal(toLinear(parseMtef(eqn(line(hat)))), 'Â');
    });
});

describe('toOmml', () => {

    test('a script takes the fragment before it as its base', () => {
        const omml = toOmml(parseMtef(eqn(line(ch('x'), sup('2')))));
        assert.match(omml, /^<m:oMath><m:sSup><m:e><m:r><m:t xml:space="preserve">x<\/m:t><\/m:r><\/m:e><m:sup>/);
    });

    test('a script after a closing parenthesis takes the whole group', () => {
        const omml = toOmml(parseMtef(eqn(line(chars('a+'), ch('('), chars('x+1'), ch(')'), sup('2')))));
        const text = (xml) => xml.replace(/<[^>]+>/g, '');
        const base = omml.match(/<m:sSup><m:e>(.*?)<\/m:e>/)[1];
        assert.equal(text(base), '(x+1)');
        assert.equal(text(omml.slice(0, omml.indexOf('<m:sSup>'))), 'a+');
    });

    test('fractions, roots and fences map to their Office Math elements', () => {
        assert.match(toOmml(parseMtef(eqn(line(frac(chars('1'), chars('2')))))), /<m:f><m:num>.*<\/m:num><m:den>.*<\/m:den><\/m:f>/);
        assert.match(toOmml(parseMtef(eqn(line(tmpl(10, 0, line(ch('x'))))))), /<m:rad><m:radPr><m:degHide m:val="1"\/>/);
        const brace = tmpl(2, 1, line(ch('x')), ch('{'));
        assert.match(toOmml(parseMtef(eqn(line(brace)))), /<m:begChr m:val="\{"\/><m:endChr m:val=""\/>/);
    });

    test('variables stay italic, digits and functions are upright', () => {
        const omml = toOmml(parseMtef(eqn(line(ch('x'), ch('2', NUMBER)))));
        assert.match(omml, /<m:t xml:space="preserve">x<\/m:t>/);
        assert.match(omml, /<m:sty m:val="p"\/><\/m:rPr><m:t xml:space="preserve">2</);
    });

    test('a construct it does not know is refused, not guessed', () => {
        assert.throws(() => toOmml(parseMtef(eqn(line(tmpl(26, 0, line(ch('x'))))))), UnsupportedMath);
        assert.throws(() => toOmml(parseMtef(eqn(line(ch(''))))), UnsupportedMath);
    });
});

// ─── CFB: a one-stream compound file, built by hand ─────────────────────────

/** Header, one FAT sector, one directory sector, then the stream's sectors. */
function compoundFile(name, data) {
    const SECTOR = 512;
    const dataSectors = Math.ceil(data.length / SECTOR);
    const file = new Uint8Array(SECTOR * (3 + dataSectors));
    const view = new DataView(file.buffer);
    file.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    view.setUint16(0x1A, 0x3E, true);
    view.setUint16(0x1C, 3, true);
    view.setUint16(0x1E, 9, true);
    view.setUint16(0x20, 6, true);
    view.setUint32(0x2C, 1, true);
    view.setUint32(0x30, 1, true);
    view.setUint32(0x38, 4096, true);
    view.setUint32(0x3C, 0xFFFFFFFE, true);
    view.setUint32(0x44, 0xFFFFFFFE, true);
    for (let i = 0; i < 109; i++) view.setUint32(0x4C + i * 4, i === 0 ? 0 : 0xFFFFFFFF, true);

    const fat = SECTOR;
    for (let i = 0; i < 128; i++) view.setUint32(fat + i * 4, 0xFFFFFFFF, true);
    view.setUint32(fat, 0xFFFFFFFD, true);
    view.setUint32(fat + 4, 0xFFFFFFFE, true);
    for (let s = 2; s < 2 + dataSectors; s++) view.setUint32(fat + s * 4, s === 1 + dataSectors ? 0xFFFFFFFE : s + 1, true);

    const dir = SECTOR * 2;
    const entry = (i, entryName, type, start, size) => {
        const e = dir + i * 128;
        [...entryName].forEach((c, j) => view.setUint16(e + j * 2, c.charCodeAt(0), true));
        view.setUint16(e + 0x40, (entryName.length + 1) * 2, true);
        file[e + 0x42] = type;
        view.setUint32(e + 0x74, start, true);
        view.setUint32(e + 0x78, size, true);
    };
    entry(0, 'Root Entry', 5, 0xFFFFFFFE, 0);
    entry(1, name, 2, 2, data.length);
    file.set(data, SECTOR * 3);
    return file;
}

describe('readCfbStream', () => {

    test('reads a stream by name through the FAT', () => {
        const data = new Uint8Array(5000).map((_, i) => i % 251);
        const file = compoundFile('Equation Native', data);
        assert.equal(isCfb(file), true);
        assert.deepEqual(readCfbStream(file, 'Equation Native'), data);
        assert.equal(readCfbStream(file, 'Missing'), null);
    });

    test('refuses something that is not a compound file', () => {
        assert.equal(isCfb(new Uint8Array(600)), false);
        assert.throws(() => readCfbStream(new Uint8Array(600), 'x'), /Not an OLE/);
    });
});
