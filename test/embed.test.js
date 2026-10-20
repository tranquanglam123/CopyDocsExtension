import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmbed, pickEmbeds, originsToRequest, fileNameOf } from '../src/lib/embed.js';
import { EMBED_KINDS, FILE_LIMITS } from '../src/lib/const.js';
import { isLegacyVnFont } from '../src/lib/vnfont.js';

const PAGE = 'https://thcs.toanmath.com/2026/05/de-cuoi-ki-2-toan-8.html';

describe('classifyEmbed', () => {

    test('a pdf.js viewer resolves to the file in its `file` parameter', () => {
        const e = classifyEmbed(
            'https://thcs.toanmath.com/wp-content/plugins/wonderplugin-pdf-embed/pdfjslight/web/viewer.html?v=2&file=https://thcs.toanmath.com/thcs-pdf/de.pdf',
            PAGE
        );
        assert.equal(e.kind, EMBED_KINDS.FILE);
        assert.equal(e.fileUrl, 'https://thcs.toanmath.com/thcs-pdf/de.pdf');
        assert.equal(e.ext, 'pdf');
        assert.equal(e.via, 'pdfjs');
    });

    test('a viewer `file` may be relative to the viewer, or sit after the hash', () => {
        const rel = classifyEmbed('/pdfjs/web/viewer.html?file=..%2F..%2Fdocs%2Fa.pdf', PAGE);
        assert.equal(rel.fileUrl, 'https://thcs.toanmath.com/docs/a.pdf');
        const hash = classifyEmbed('https://x.vn/web/viewer.html#file=/f/b.pdf', PAGE);
        assert.equal(hash.fileUrl, 'https://x.vn/f/b.pdf');
    });

    test('Office Online resolves to the .docx it renders', () => {
        const e = classifyEmbed(
            '//view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Fthuvienhoclieu.com%2Fwp-content%2Fuploads%2Fa.docx',
            'https://thuvienhoclieu.com/de-cuong/'
        );
        assert.equal(e.fileUrl, 'https://thuvienhoclieu.com/wp-content/uploads/a.docx');
        assert.equal(e.ext, 'docx');
        assert.equal(e.via, 'office');
    });

    test('the Google Docs viewer unwraps `url`, and `srcid` as a Drive file', () => {
        assert.equal(
            classifyEmbed('https://docs.google.com/viewer?url=https://a.vn/x.pdf&embedded=true', PAGE).fileUrl,
            'https://a.vn/x.pdf'
        );
        assert.equal(
            classifyEmbed('https://docs.google.com/viewer?srcid=ABC123&pid=explorer&embedded=true', PAGE).fileUrl,
            'https://drive.google.com/uc?export=download&id=ABC123'
        );
    });

    test('a Drive preview becomes its download URL and needs the Drive hosts', () => {
        const e = classifyEmbed('https://drive.google.com/file/d/1AbC_d-9/preview', PAGE);
        assert.equal(e.kind, EMBED_KINDS.FILE);
        assert.equal(e.fileUrl, 'https://drive.google.com/uc?export=download&id=1AbC_d-9');
        assert.ok(e.origins.includes('https://drive.usercontent.google.com/*'));
    });

    test('an embedded Google Doc or Sheet routes to the existing paths', () => {
        const doc = classifyEmbed('https://docs.google.com/document/d/DOC1/preview', PAGE);
        assert.equal(doc.kind, EMBED_KINDS.GDOC);
        assert.equal(doc.fileUrl, 'https://docs.google.com/document/d/DOC1/edit');
        assert.equal(doc.downloadUrl, 'https://docs.google.com/document/d/DOC1/export?format=docx');
        const sheet = classifyEmbed('https://docs.google.com/spreadsheets/d/SH1/htmlview', PAGE);
        assert.equal(sheet.kind, EMBED_KINDS.GSHEET);
    });

    test('a published Doc is plain HTML, and Slides reads through its PDF export', () => {
        const pub = classifyEmbed('https://docs.google.com/document/d/e/2PACX-1v/pub?embedded=true', PAGE);
        assert.equal(pub.kind, EMBED_KINDS.HTML);
        assert.equal(pub.fileUrl, 'https://docs.google.com/document/d/e/2PACX-1v/pub');
        const slides = classifyEmbed('https://docs.google.com/presentation/d/SL1/embed?start=false', PAGE);
        assert.equal(slides.kind, EMBED_KINDS.FILE);
        assert.equal(slides.fileUrl, 'https://docs.google.com/presentation/d/SL1/export/pdf');
    });

    test('a direct file link is a file; anything else is not an embed', () => {
        assert.equal(classifyEmbed('/uploads/De%20thi.docx?ver=2', PAGE).ext, 'docx');
        assert.equal(classifyEmbed('https://www.youtube.com/embed/xyz', PAGE), null);
        assert.equal(classifyEmbed('https://www.facebook.com/plugins/page.php?href=x', PAGE), null);
        assert.equal(classifyEmbed('javascript:void(0)', PAGE), null);
        assert.equal(classifyEmbed('', PAGE), null);
        assert.equal(classifyEmbed(undefined, PAGE), null);
    });
});

describe('pickEmbeds', () => {

    test('frames win over links, and the same file is listed once', () => {
        const { embeds } = pickEmbeds([
            { tag: 'a', src: 'https://x.vn/a.pdf', inArticle: true },
            { tag: 'iframe', src: 'https://x.vn/web/viewer.html?file=/a.pdf', area: 800 * 550 },
            { tag: 'embed', src: 'https://x.vn/a.pdf', area: 800 * 550 },
        ], 'https://x.vn/post.html');
        assert.equal(embeds.length, 1);
        assert.equal(embeds[0].fileUrl, 'https://x.vn/a.pdf');
    });

    test('a widget-sized frame is ignored; a frame of unknown size is kept', () => {
        const { embeds } = pickEmbeds([
            { tag: 'iframe', src: 'https://x.vn/tiny.pdf', area: 100 * 30 },
            { tag: 'iframe', src: 'https://x.vn/lazy.pdf', area: 0 },
        ], 'https://x.vn/post.html');
        assert.deepEqual(embeds.map((e) => e.fileUrl), ['https://x.vn/lazy.pdf']);
    });

    test('links count only inside the article, and only with no frames', () => {
        const { embeds } = pickEmbeds([
            { tag: 'a', src: '/sidebar.pdf', inArticle: false },
            { tag: 'a', src: '/de-thi.docx', inArticle: true },
        ], 'https://x.vn/post.html');
        assert.deepEqual(embeds.map((e) => e.fileUrl), ['https://x.vn/de-thi.docx']);
    });

    test(`at most ${FILE_LIMITS.MAX_EMBEDS} embeds, with the rest counted`, () => {
        const many = Array.from({ length: FILE_LIMITS.MAX_EMBEDS + 2 }, (_, i) => ({ tag: 'iframe', src: `/f${i}.pdf` }));
        const { embeds, overflow } = pickEmbeds(many, 'https://x.vn/');
        assert.equal(embeds.length, FILE_LIMITS.MAX_EMBEDS);
        assert.equal(overflow, 2);
    });

    test('survives garbage input', () => {
        assert.deepEqual(pickEmbeds(null, PAGE), { embeds: [], overflow: 0 });
        assert.deepEqual(pickEmbeds([null, {}, { tag: 'iframe' }], PAGE).embeds, []);
    });
});

describe('originsToRequest / fileNameOf', () => {

    test('same-origin files and Docs need nothing; others need their host', () => {
        const embeds = [
            classifyEmbed('/a.pdf', 'https://x.vn/p'),
            classifyEmbed('https://cdn.y.vn/b.pdf', 'https://x.vn/p'),
            classifyEmbed('https://docs.google.com/document/d/D/edit', 'https://x.vn/p'),
        ];
        assert.deepEqual(originsToRequest(embeds, 'https://x.vn/p'), ['https://cdn.y.vn/*']);
    });

    test('names a download from the path, or leaves it to the server', () => {
        assert.equal(fileNameOf('https://x.vn/up/%C4%90e%20thi.pdf'), 'Đe thi.pdf');
        assert.equal(fileNameOf('https://drive.google.com/uc?export=download&id=1'), null);
    });
});

describe('isLegacyVnFont', () => {
    test('flags VNI and TCVN3 font names, subset prefix or not', () => {
        assert.equal(isLegacyVnFont('SLIIDO+VNI-Times'), true);
        assert.equal(isLegacyVnFont('.VnTime'), true);
        assert.equal(isLegacyVnFont('VnTimeH'), true);
        assert.equal(isLegacyVnFont('TimesNewRomanPSMT'), false);
        assert.equal(isLegacyVnFont('Cambria Math'), false);
        assert.equal(isLegacyVnFont(undefined), false);
    });
});
