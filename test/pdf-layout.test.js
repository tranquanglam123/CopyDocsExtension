import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layoutPages, planPage, buildLines, fontFamilyOf } from '../src/lib/pdf-layout.js';

// Positioned like pdf.js output at scale 1: a 12pt body on an A4 page whose
// text runs from x=72 to x=523.
const item = (str, x, y, extra = {}) => ({ str, x, y, w: str.length * 6, h: 12, ...extra });
const page = (items, extra = {}) => ({ width: 595, height: 842, items, shapes: [], pictures: [], ...extra });
// A line reaching the right edge of the text block, which every page here has.
const full = (text, y) => ({ ...item(text, 72, y), w: 451 });
const rect = (x0, y0, x1, y1, fill = '#000000') => ({ x0, y0, x1, y1, fill, stroke: false, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true, curved: false });
const html = (pages) => layoutPages(pages).bodyHtml;
const paragraphs = (body) => [...body.matchAll(/<p style="([^"]*)"[^>]*>(.*?)<\/p>/g)].map((m) => ({ style: m[1], text: m[2].replace(/<[^>]+>/g, '') }));

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

    test('a gap wider than any word space splits the line into tab-separated parts', () => {
        const [line] = buildLines([item('A. 2', 72, 100), item('B. 3', 200, 100)]);
        assert.deepEqual(line.segments.map((s) => s.x0), [72, 200]);
    });

    test('whitespace-only and zero-size items are dropped', () => {
        assert.equal(buildLines([item('  ', 72, 100), { str: 'a', x: 0, y: 0, w: 1, h: 0 }]).length, 0);
    });
});

describe('layoutPages: pages and paragraphs', () => {

    test('each page is a section of its own size, margins taken from what is on pages of its shape', () => {
        const body = html([page([full('Dòng một', 100), item('Cuối', 72, 700)]), { ...page([item('Ngang', 50, 80)]), width: 842, height: 595 }]);
        const sections = [...body.matchAll(/<section data-page="([^"]+)" data-margins="([^"]+)">/g)].map((m) => [m[1], m[2].split(' ').map(Number)]);
        assert.deepEqual(sections.map((s) => s[0]), ['595 842', '842 595']);
        const [top, right, , left] = sections[0][1];
        assert.equal(left, 72);
        assert.equal(right, 595 - 523);
        assert.ok(top > 80 && top < 100);
    });

    test('a line continues the paragraph above when its first word would not have fitted there', () => {
        const ps = paragraphs(html([page([full('Một đoạn văn dài', 100), item('kết thúc.', 72, 114)])]));
        assert.equal(ps.length, 1);
        assert.match(ps[0].text, /dài kết thúc/);
    });

    test('a line whose first word would have fitted above starts its own paragraph', () => {
        const ps = paragraphs(html([page([full('Dòng một', 100), item('Ngắn.', 72, 114), item('Đoạn mới', 72, 128)])]));
        assert.equal(ps.length, 2);
    });

    test('a question or answer marker starts a paragraph even after a full line', () => {
        const ps = paragraphs(html([page([full('Đề bài dài', 100), item('Câu 2. Tính', 72, 114)])]));
        assert.equal(ps.length, 2);
    });

    test('a gap between lines becomes space before, and lines keep their pitch', () => {
        const ps = paragraphs(html([page([full('Lề', 60), item('Một', 72, 100), item('Hai', 72, 114), item('Ba', 72, 160)])]));
        const before = ps.map((p) => Number(/margin:([\d.]+)pt/.exec(p.style)[1]));
        assert.equal(before[2], 0);
        assert.ok(before[3] > 25 && before[3] < 40, `space before the last: ${before[3]}`);
        assert.match(ps[1].style, /line-height:14pt/);
    });

    test('lines set tighter than Word\'s single spacing are set exactly', () => {
        const ps = paragraphs(html([page([full('Lề', 60), item('Một', 72, 100), item('Hai', 72, 112), item('Ba', 72, 124)])]));
        assert.match(ps[2].style, /line-height:12pt;mso-line-height-rule:exactly/);
    });

    test('indents come from where the lines start; a wrapped paragraph that fills the line is justified', () => {
        const ps = paragraphs(html([page([
            full('Đầu', 80),
            { ...item('Thụt đầu dòng', 108, 100), w: 415 },
            { ...item('dòng tiếp', 72, 114), w: 451 },
            item('hết.', 72, 128),
        ])]));
        assert.match(ps[1].style, /margin:[\d.]+pt 0 0pt 0pt;text-indent:36pt;text-align:justify/);
    });

    test('a short line on the centre line is centred', () => {
        const ps = paragraphs(html([page([full('Lề trái', 80), item('TIÊU ĐỀ', 276, 100)])]));
        assert.match(ps[1].style, /text-align:center/);
    });

    test('bold, italic, fonts and sizes come out as markup, each run stating only a difference', () => {
        const tnr = { fontName: 'BGSBKB+TimesNewRomanPSMT' };
        const body = html([page([
            item('Cho hàm số ', 72, 100, { ...tnr, bold: true }),
            item('y', 138, 100, { ...tnr, h: 14, italic: true }),
            item(' và đồ thị', 146, 100, tnr),
        ])]);
        assert.match(body, /<span style="font-family:'Times New Roman';font-size:12pt"><b>Cho hàm số <\/b><span style="font-size:14pt"><i>y<\/i><\/span> và đồ thị<\/span>/);
    });

    test('markup is escaped', () => {
        assert.match(html([page([item('a < b & c', 72, 100)])]), /a &lt; b &amp; c/);
    });

    test('no pages, no output', () => {
        assert.deepEqual(layoutPages([]), { bodyHtml: '', text: '', ole: [] });
    });
});

describe('layoutPages: tab stops, columns and tables', () => {

    test('parts of a line sit at tab stops measured from the text edge', () => {
        const body = html([page([full('Câu 1: Chọn đáp án đúng', 80), item('A. 2', 90, 100), item('B. 3', 200, 100), item('C. 4', 320, 100)])]);
        assert.match(body, /data-tabs="128 248">.*A\. 2.*<span data-tab[^>]*><\/span>.*B\. 3.*<span data-tab[^>]*><\/span>.*C\. 4/);
        assert.match(layoutPages([page([item('A. 2', 72, 100), item('B. 3', 200, 100)])]).text, /A\. 2\tB\. 3/);
    });

    test('lines that keep a gutter between centred columns are a borderless table', () => {
        const body = html([page([
            full('Lề', 60),
            item('SỞ GIÁO DỤC', 90, 100), item('ĐỀ KIỂM TRA', 360, 100),
            item('TRƯỜNG THCS', 87, 114), item('NĂM HỌC 2025', 354, 114),
        ])]);
        assert.match(body, /<table style="margin-left:-5.4pt;[^"]*table-layout:fixed[^"]*">.*<td style="border:none[^"]*">.*SỞ GIÁO DỤC.*TRƯỜNG THCS.*<\/td><td style="border:none[^"]*">.*ĐỀ KIỂM TRA.*NĂM HỌC 2025/s);
    });

    test('ruled cells become a table on the rules\' grid, a missing inner rule merging two cells', () => {
        const t = 0.5;
        // Two columns, two rows; the top row has no rule between its columns.
        const shapes = [
            rect(72, 100, 372, 100 + t), rect(72, 120, 372, 120 + t), rect(72, 140, 372, 140 + t),
            rect(72, 100, 72 + t, 140 + t), rect(222, 120, 222 + t, 140 + t), rect(372, 100, 372 + t, 140 + t),
        ];
        const body = html([page([item('Tiêu đề', 190, 114), item('Ô một', 80, 134), item('Ô hai', 230, 134)], { shapes })]);
        assert.match(body, /<table style="margin-left:0pt;width:300pt;table-layout:fixed;border-collapse:collapse"><colgroup><col style="width:150pt"><col style="width:150pt"><\/colgroup>/);
        assert.match(body, /<td colspan="2" style="border-top:0.5pt solid #000000;[^"]*">.*Tiêu đề/);
        assert.match(body, /<tr style="height:20pt"><td style="[^"]*">.*Ô một.*<\/td><td style="[^"]*">.*Ô hai/);
        assert.match(layoutPages([page([item('Ô một', 80, 134), item('Ô hai', 230, 134)], { shapes })]).text, /\nÔ một\tÔ hai/);
    });
});

describe('layoutPages: pictures and equations', () => {

    test('a picture on its own is planned as a crop and placed in the flow', () => {
        const p = page([item('Trên', 72, 100), item('Dưới', 72, 300)], { pictures: [{ x0: 200, y0: 150, x1: 400, y1: 250 }] });
        const { crops } = planPage(p);
        assert.deepEqual(crops, [{ x0: 200, y0: 150, x1: 400, y1: 250 }]);
        const { bodyHtml, text } = layoutPages([{ ...p, crops: [{ src: 'data:image/jpeg;base64,AA' }] }]);
        assert.deepEqual(paragraphs(bodyHtml).map((q) => q.text || 'IMG'), ['Trên', 'IMG', 'Dưới']);
        assert.match(bodyHtml, /<img src="data:image\/jpeg;base64,AA" width="267" alt="">/);
        assert.equal(text, 'Trên\n\nDưới');
    });

    test('a picture beside lines of text floats at its place on the page', () => {
        const lines = [item('Câu 9: Cho tam giác', 72, 100), item('A. k = 4', 72, 114), item('B. k = 6', 72, 128)];
        const p = page(lines, { pictures: [{ x0: 300, y0: 95, x1: 450, y1: 140 }] });
        const body = html([{ ...p, crops: [{ src: 'data:image/jpeg;base64,AA' }] }]);
        assert.match(body, /<img src="data:image\/jpeg;base64,AA" width="200" data-float="300 95" alt="">/);
        assert.equal(paragraphs(body).length, 3);
    });

    test('a tagged equation with a fraction bar is rebuilt as Office Math, marked in the text', () => {
        const g = { group: 'InlineShape:7' };
        const p = page([
            item('Tính', 72, 110),
            { ...item('1', 112, 104), ...g },
            { ...item('2', 112, 118), ...g },
            item('là', 130, 110),
        ], { shapes: [{ ...rect(110, 107.7, 120, 108.2), ...g }] });
        const { bodyHtml, ole } = layoutPages([p]);
        assert.equal(ole.length, 1);
        assert.match(ole[0].omml, /^<m:oMath><m:f><m:num>.*1.*<\/m:num><m:den>.*2.*<\/m:den><\/m:f><\/m:oMath>$/);
        assert.match(bodyHtml, /Tính <span data-ole="0">1\/2<\/span> là/);
    });

    test('Cambria Math whose text reads doubled is kept as a picture inside its line', () => {
        const cm = { fontName: 'NJOLWD+CambriaMath', h: 14 };
        const p = page([
            item('A.', 72, 200),
            { ...item('\u{1D434}\u{1D434}\u{1D435}\u{1D435}', 90, 200, cm), w: 18 },
            { ...item('2', 108, 195, cm), h: 10, w: 6 },
            item('B.', 200, 200),
        ]);
        const { crops } = planPage(p);
        assert.equal(crops.length, 1);
        const body = html([{ ...p, crops: [{ src: 'data:image/jpeg;base64,AA' }] }]);
        assert.match(body, /A\. <img src="data:image\/jpeg;base64,AA" width="\d+" style="vertical-align:-[\d.]+pt" alt="">/);
        assert.doesNotMatch(body, /\u{1D434}/u);
    });
});

describe('fontFamilyOf', () => {

    test('a subset PostScript name is the family Word knows', () => {
        assert.equal(fontFamilyOf('OXCWKB+TimesNewRomanPS-BoldMT'), 'Times New Roman');
        assert.equal(fontFamilyOf('ArialMT'), 'Arial');
        assert.equal(fontFamilyOf('Calibri,Bold'), 'Calibri');
        assert.equal(fontFamilyOf('Times-Roman'), 'Times New Roman');
        assert.equal(fontFamilyOf('MT-Extra'), 'MT Extra');
    });

    test('a legacy Vietnamese font keeps its name; a Type 3 name is no family', () => {
        assert.equal(fontFamilyOf('SLIIDO+VNI-Times'), 'VNI-Times');
        assert.equal(fontFamilyOf('g_d0_f1'), null);
        assert.equal(fontFamilyOf(undefined), null);
    });
});
