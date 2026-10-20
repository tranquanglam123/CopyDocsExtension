import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layoutPages, paragraphsOf, buildLines } from '../src/lib/pdf-layout.js';

// Positioned like pdf.js output at scale 1: a 12pt body on a 595pt-wide page,
// text block from x=72 to x=523.
const item = (str, x, y, extra = {}) => ({ str, x, y, w: str.length * 6, h: 12, ...extra });
const full = (text, y) => item(text.padEnd(75, 'x'), 72, y);

describe('buildLines', () => {

    test('items on one baseline join in x order, with a space across a gap', () => {
        const [line] = buildLines([item('world', 120, 100), item('Hello', 72, 100)]);
        assert.equal(line.plain, 'Hello world');
    });

    test('a raised, smaller item is a superscript on the same line', () => {
        const lines = buildLines([
            item('x', 72, 100),
            { str: '2', x: 78, y: 95, w: 4, h: 8 },
            item('+ 1', 84, 100),
        ]);
        assert.equal(lines.length, 1);
        assert.deepEqual(lines[0].runs.map((r) => r.script), [null, 'sup', null]);
    });

    test('a wide gap inside a line becomes an em space, as in answer choices', () => {
        const [line] = buildLines([item('A. 2', 72, 100), item('B. 3', 200, 100)]);
        assert.equal(line.plain, 'A. 2 B. 3');
    });

    test('whitespace-only and zero-size items are dropped', () => {
        assert.equal(buildLines([item('  ', 72, 100), { str: 'a', x: 0, y: 0, w: 1, h: 0 }]).length, 0);
    });
});

describe('paragraphsOf', () => {

    test('a line reaching the margin continues into the next one', () => {
        const paras = paragraphsOf([full('Một đoạn văn dài', 100), item('kết thúc.', 72, 114)]);
        assert.equal(paras.length, 1);
    });

    test('a short line ends its paragraph', () => {
        const paras = paragraphsOf([full('Dòng một', 100), item('Ngắn.', 72, 114), item('Đoạn mới', 72, 128)]);
        assert.equal(paras.length, 2);
    });

    test('a question or answer marker starts a paragraph even after a full line', () => {
        const paras = paragraphsOf([full('Đề bài dài', 100), item('Câu 2. Tính', 72, 114)]);
        assert.equal(paras.length, 2);
    });

    test('a blank line ends a paragraph', () => {
        const paras = paragraphsOf([full('Dòng một', 100), item('Dòng hai', 72, 140)]);
        assert.equal(paras.length, 2);
    });

    test('bold, italic and a larger size come out as tags', () => {
        const [title, body] = paragraphsOf([
            { ...item('ĐỀ KIỂM TRA', 72, 80), h: 18, bold: true },
            item('Thời gian ', 72, 120, { italic: true }),
            { ...full('làm bài', 120), x: 132 },
        ]);
        assert.match(title.html, /^<h1><b>ĐỀ KIỂM TRA<\/b><\/h1>$/);
        assert.match(body.html, /^<p><i>Thời gian <\/i>làm bài/);
    });

    test('a short line on the centre line is centred', () => {
        const [, centred] = paragraphsOf([full('Lề trái', 80), item('TIÊU ĐỀ', 276, 120)]);
        assert.match(centred.html, /^<p style="text-align:center">/);
    });

    test('markup is escaped', () => {
        const [p] = paragraphsOf([item('a < b & c', 72, 100)]);
        assert.match(p.html, /a &lt; b &amp; c/);
    });
});

describe('layoutPages', () => {

    test('images interleave with paragraphs by position, and stay out of the text', () => {
        const { bodyHtml, text } = layoutPages([
            { items: [item('Trên', 72, 100), item('Dưới', 72, 300)], images: [{ y: 150, html: '<p><img src="data:x"></p>' }] },
            { items: [item('Trang hai', 72, 100)] },
        ]);
        assert.deepEqual(bodyHtml.split('\n').map((l) => l.replace(/<[^>]+>/g, '') || 'IMG'), ['Trên', 'IMG', 'Dưới', 'Trang hai']);
        assert.equal(text, 'Trên\n\nDưới\n\nTrang hai');
    });

    test('no pages, no output', () => {
        assert.deepEqual(layoutPages([]), { bodyHtml: '', text: '' });
    });
});
