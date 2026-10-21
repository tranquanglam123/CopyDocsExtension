/**
 * Cleaned HTML to .docx (OOXML, Office 2007+) — a ZIP of [Content_Types].xml,
 * _rels/.rels, docProps/core.xml, word/document.xml, its relationships,
 * styles and numbering, plus word/media/ for pictures and word/embeddings/
 * for kept OLE objects. Only `data:` pictures are written; a linked one
 * would need fetching.
 *
 * Every inline style the HTML carries (font, size, colour, highlight,
 * alignment, indents, spacing, cell merges) is written as real Word
 * formatting, so the file reads like the source and still edits as text.
 * Unstyled text gets the house style of Vietnamese school material: A4,
 * Times New Roman 13.
 *
 * Lives in popup/ because it parses with `DOMParser` and so needs a realm with
 * a DOM. Its pure dependency, the ZIP writer, stays in lib/zip.js.
 */

import { MiniZip } from '../lib/zip.js';
import { OLE_PLACEHOLDERS } from '../lib/const.js';

const REL_OLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_LINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_NUMBERING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const REL_SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';

const MEDIA_TYPES = {
    bin: 'application/vnd.openxmlformats-officedocument.oleObject',
    wmf: 'image/x-wmf',
    emf: 'image/x-emf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
};

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/** EMU per CSS pixel. */
const EMU_PER_PX = 9525;

/** A4 with 2.5 cm left and 2 cm other margins, in twips. */
const PAGE = { width: 11906, height: 16838, top: 1134, right: 1134, bottom: 1134, left: 1418 };

/** EMU per point, for pictures placed on the page. */
const EMU_PER_PT = 12700;

/**
 * Carries a section's properties when the section ends in a table: an
 * empty paragraph too small to push anything onto a new page.
 */
const CARRIER_PPR = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>';

/** Marks where a section ends in the body being written; replaced once the body is complete. */
const SECTION_MARK = '\u0000section:';

const BASE_FONT = 'Times New Roman';
/** Half-points. */
const BASE_SIZE = 26;
const HEADING_SIZES = [32, 28, 26, 26, 26, 26];

/** Indent per list level, in twips. */
const LIST_INDENT = 567;

/** Elements that start their own paragraph (or table) rather than flow inline. */
const BLOCK_TAGS = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR',
    'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'ADDRESS', 'FIGURE', 'FIGCAPTION',
    'CENTER', 'DL', 'DT', 'DD', 'CAPTION', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY',
]);
const BLOCK_SELECTOR = [...BLOCK_TAGS].map((t) => t.toLowerCase()).join(',');

/** CSS `list-style-type` to Word's number format and level text. */
const LIST_FORMATS = {
    disc: ['bullet', '•'], circle: ['bullet', '◦'], square: ['bullet', '▪'],
    decimal: ['decimal', '%.'], 'lower-alpha': ['lowerLetter', '%.'], 'lower-latin': ['lowerLetter', '%.'],
    'upper-alpha': ['upperLetter', '%.'], 'upper-latin': ['upperLetter', '%.'],
    'lower-roman': ['lowerRoman', '%.'], 'upper-roman': ['upperRoman', '%.'],
};
const OL_TYPES = { a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', 1: 'decimal' };

const NAMED_COLORS = {
    black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00',
    gray: '808080', grey: '808080', silver: 'C0C0C0', maroon: '800000', navy: '000080', purple: '800080',
    orange: 'FFA500', teal: '008080', olive: '808000', lime: '00FF00', aqua: '00FFFF', fuchsia: 'FF00FF',
};

const GENERIC_FONTS = { serif: 'Times New Roman', 'sans-serif': 'Arial', monospace: 'Courier New' };

const LINK_COLOR = '0563C1';

/** The picture-frame shapetype every OLE preview shape names; written once. */
const OLE_SHAPETYPE = '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:formulas><v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/><v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/><v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/></v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>';

/**
 * @typedef {{bold?: boolean, italic?: boolean, underline?: boolean, strike?: boolean,
 *   script?: 'sup'|'sub'|null, size?: number, color?: string, fill?: string, highlight?: string,
 *   font?: string, link?: string, caps?: boolean, smallCaps?: boolean, pre?: boolean}} RunFormat
 *   `size` in half-points; colours as RRGGBB.
 * @typedef {{style?: string, align?: string, left?: number, firstLine?: number, before?: number,
 *   after?: number, line?: number, lineRule?: string, fill?: string, rule?: boolean,
 *   num?: {numId: number, ilvl: number, used: boolean}, size?: number}} ParaFormat
 *   Lengths in twips; `size` is the inherited font size, for `em`.
 * @typedef {{text: string, fmt: RunFormat, image?: string, width?: number, ole?: number, br?: boolean, tab?: boolean}} Run
 */

/**
 * The package being written. Set only for the duration of one synchronous
 * generate(), so the static run writers can allocate relationships without
 * threading it through every call.
 * @type {{ole: object[], rels: Array<{id: string, type: string, target: string, external?: boolean}>,
 *   files: Array<{path: string, base64: string}>, exts: Set<string>, lists: Array<{format: string, text: string, start: number}>,
 *   links: Map<string, string>, sections: object[], page: object, markAt: number, last: object|null}|null}
 *   `page`: the geometry of the section being written, in twips; `sections`
 *   every section ended, in order; `markAt` where the body after the last
 *   one starts; `last` the geometry the body's own sectPr takes.
 */
let pkg = null;

export class DocxGenerator {

    /**
     * Generate a .docx Blob from HTML content.
     * @param {string} html       Cleaned HTML (body innerHTML only, no <html> wrapper)
     * @param {string} [title]    Document title
     * @param {{ole?: object[]}} [opts]  OLE objects the HTML marks with
     *   `data-ole`, from offscreen/file/docx.js: a converted MathType equation
     *   is written as Office Math, anything else back as the original object.
     * @returns {Blob}            .docx file as Blob
     */
    static generate(html, title = 'Document', { ole = [] } = {}) {
        const zip = new MiniZip();
        pkg = { ole, rels: [], files: [], exts: new Set(), lists: [], links: new Map(), sections: [], page: PAGE, markAt: 0, last: null };

        try {
            // document.xml first: writing it is what allocates the other parts.
            const documentXml = DocxGenerator._document(html);
            const numbered = pkg.lists.length > 0;
            if (numbered) pkg.rels.push({ id: 'rIdNumbering', type: REL_NUMBERING, target: 'numbering.xml' });
            pkg.rels.push({ id: 'rIdSettings', type: REL_SETTINGS, target: 'settings.xml' });

            zip.addFile('[Content_Types].xml', DocxGenerator._contentTypes(pkg.exts, numbered));
            zip.addFile('_rels/.rels', DocxGenerator._rootRels());
            zip.addFile('docProps/core.xml', DocxGenerator._core(title));
            zip.addFile('word/_rels/document.xml.rels', DocxGenerator._docRels(pkg.rels));
            zip.addFile('word/styles.xml', DocxGenerator._styles());
            zip.addFile('word/settings.xml', DocxGenerator._settings());
            if (numbered) zip.addFile('word/numbering.xml', DocxGenerator._numbering(pkg.lists));
            zip.addFile('word/document.xml', documentXml);
            for (const file of pkg.files) {
                zip.addFile(file.path, Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)));
            }

            return zip.toBlob();
        } finally {
            pkg = null;
        }
    }

    // ─── XML Templates ──────────────────────────────────

    /**
     * @param {Set<string>} [exts]  Extensions of the binary parts written.
     * @param {boolean} [numbered]  Whether word/numbering.xml is written.
     */
    static _contentTypes(exts = new Set(), numbered = false) {
        const defaults = [...exts]
            .filter((ext) => MEDIA_TYPES[ext])
            .map((ext) => `\n  <Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext]}"/>`)
            .join('');
        const numbering = numbered
            ? '\n  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
            : '';
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>${defaults}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${numbering}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
    }

    static _rootRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
    }

    /** @param {string} title */
    static _core(title) {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${DocxGenerator._escapeXml(title || '')}</dc:title>
</cp:coreProperties>`;
    }

    /** @param {Array<{id: string, type: string, target: string, external?: boolean}>} [extra] */
    static _docRels(extra = []) {
        const rels = extra
            .map((r) => `\n  <Relationship Id="${r.id}" Type="${r.type}" Target="${DocxGenerator._escapeXml(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
            .join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels}
</Relationships>`;
    }

    static _styles() {
        const headings = HEADING_SIZES.map((sz, i) => `
  <w:style w:type="paragraph" w:styleId="Heading${i + 1}">
    <w:name w:val="heading ${i + 1}"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${i < 2 ? 240 : 160}" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>
  </w:style>`).join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${BASE_FONT}" w:hAnsi="${BASE_FONT}" w:eastAsia="${BASE_FONT}" w:cs="${BASE_FONT}"/>
        <w:sz w:val="${BASE_SIZE}"/>
        <w:szCs w:val="${BASE_SIZE}"/>
        <w:lang w:val="vi-VN" w:eastAsia="en-US" w:bidi="ar-SA"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>${headings}
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/>
    <w:rPr><w:color w:val="${LINK_COLOR}"/><w:u w:val="single"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:default="1" w:styleId="TableNormal">
    <w:name w:val="Normal Table"/>
    <w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>
  </w:style>
</w:styles>`;
    }

    /**
     * Word 2013 layout rather than compatibility mode: a table's indent then
     * places its border, as the PDF and HTML sources measure it.
     */
    static _settings() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;
    }

    /**
     * One abstract definition per list: its format on every level, so a
     * nested list of the same kind indents and numbers as the browser drew it.
     * @param {Array<{format: string, text: string, start: number}>} lists
     */
    static _numbering(lists) {
        const abstract = lists.map((list, i) => {
            const levels = Array.from({ length: 9 }, (_, lvl) => {
                const text = list.format === 'bullet' ? list.text : list.text.replace('%', `%${lvl + 1}`);
                const font = list.format === 'bullet' ? `<w:rPr><w:rFonts w:ascii="${BASE_FONT}" w:hAnsi="${BASE_FONT}"/></w:rPr>` : '';
                return `<w:lvl w:ilvl="${lvl}"><w:start w:val="${list.start}"/><w:numFmt w:val="${list.format}"/>` +
                    `<w:lvlText w:val="${DocxGenerator._escapeXml(text)}"/><w:lvlJc w:val="left"/>` +
                    `<w:pPr><w:ind w:left="${LIST_INDENT * (lvl + 1)}" w:hanging="${LIST_INDENT / 2 + 76}"/></w:pPr>${font}</w:lvl>`;
            }).join('');
            return `  <w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>`;
        });
        const nums = lists.map((_, i) => `  <w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`);
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${abstract.join('\n')}
${nums.join('\n')}
</w:numbering>`;
    }

    /**
     * @param {string} html
     * @returns {string}  Complete document.xml
     */
    static _document(html) {
        const bodyXml = DocxGenerator._htmlToOoxml(html);

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
${bodyXml}
    ${DocxGenerator._sectPr(pkg?.last || PAGE)}
  </w:body>
</w:document>`;
    }

    /** @param {{width: number, height: number, top: number, right: number, bottom: number, left: number}} page  Twips. */
    static _sectPr(page) {
        const orient = page.width > page.height ? ' w:orient="landscape"' : '';
        return `<w:sectPr><w:pgSz w:w="${page.width}" w:h="${page.height}"${orient}/>` +
            `<w:pgMar w:top="${page.top}" w:right="${page.right}" w:bottom="${page.bottom}" w:left="${page.left}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
    }

    /**
     * Parse cleaned HTML and convert it to body content.
     * @param {string} html
     * @returns {string}  OOXML body content
     */
    static _htmlToOoxml(html) {
        const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
        const root = doc.body.querySelector('div') || doc.body;
        const out = [];
        DocxGenerator._blocks(root, {}, { size: BASE_SIZE }, out);
        DocxGenerator._closeSections(out);
        // A body ending in a table needs a paragraph after it.
        if (out.length === 0 || out[out.length - 1].trimStart().startsWith('<w:tbl>')) out.push(`    <w:p><w:pPr>${CARRIER_PPR}</w:pPr></w:p>`);
        return out.join('\n');
    }

    /**
     * Section ends to sectPr. A section's properties go in its last
     * paragraph, the last section's in the body; one ending in a table gets
     * a carrier paragraph. Edits `out` in place.
     * @param {string[]} out
     */
    static _closeSections(out) {
        if (!pkg) return;
        let lastMark = -1;
        out.forEach((entry, i) => { if (entry.startsWith(SECTION_MARK)) lastMark = i; });
        const trailing = lastMark >= 0 && out.slice(lastMark + 1).every((e) => e.startsWith(SECTION_MARK));
        // Marks are unique, and indices shift as carriers go in.
        const finalMark = trailing ? out[lastMark] : null;
        for (let i = 0; i < out.length; i++) {
            if (!out[i].startsWith(SECTION_MARK)) continue;
            const page = pkg.sections[Number(out[i].slice(SECTION_MARK.length))];
            if (out[i] === finalMark) {
                pkg.last = page;
                out.splice(i, 1);
                i--;
                continue;
            }
            const sect = DocxGenerator._sectPr(page);
            const prev = i > 0 ? out[i - 1] : '';
            const p = prev.includes('<w:sectPr>') ? '' : prev.trimStart();
            if (p.startsWith('<w:p><w:pPr>')) {
                out[i - 1] = prev.replace('</w:pPr>', `${sect}</w:pPr>`);
            } else if (p.startsWith('<w:p>')) {
                out[i - 1] = prev.replace('<w:p>', `<w:p><w:pPr>${sect}</w:pPr>`);
            } else if (p.startsWith('<w:p/>')) {
                out[i - 1] = prev.replace('<w:p/>', `<w:p><w:pPr>${sect}</w:pPr></w:p>`);
            } else {
                out.splice(i, 0, `    <w:p><w:pPr>${CARRIER_PPR}${sect}</w:pPr></w:p>`);
                i++;
                // A carrier stands in for the section's last paragraph; the mark is done.
            }
            out.splice(i, 1);
            i--;
        }
    }

    /**
     * A `<section data-page="w h" data-margins="t r b l">` (points) as twips.
     * @param {Element} el
     */
    static _sectionOf(el) {
        const [w, h] = String(el.dataset.page || '').split(/\s+/).map(Number);
        const [t, r, b, l] = String(el.dataset.margins || '').split(/\s+/).map(Number);
        const tw = (v, fallback) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 20) : fallback);
        return {
            width: tw(w, PAGE.width), height: tw(h, PAGE.height),
            top: tw(t, PAGE.top), right: tw(r, PAGE.right), bottom: tw(b, PAGE.bottom), left: tw(l, PAGE.left),
        };
    }

    /** The text width of the section being written, in twips. */
    static _textWidth() {
        const page = pkg?.page || PAGE;
        return Math.max(1440, page.width - page.left - page.right);
    }

    // ─── Blocks ─────────────────────────────────────────

    /**
     * Walk a container: inline content gathers into paragraphs, block
     * children recurse with their own paragraph and run formatting.
     * @param {Element} el
     * @param {RunFormat} fmt
     * @param {ParaFormat} para
     * @param {string[]} out
     */
    static _blocks(el, fmt, para, out) {
        let runs = [];
        const flush = () => {
            if (DocxGenerator._trimRuns(runs).length > 0) out.push(DocxGenerator._paragraph(runs, para));
            runs = [];
        };

        for (const node of el.childNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) {
                if (node.nodeType === Node.TEXT_NODE) runs.push(...DocxGenerator._textRuns(node.textContent, fmt));
                continue;
            }
            const tag = node.tagName;
            const isBlock = BLOCK_TAGS.has(tag) || (node.dataset?.ole === undefined && tag !== 'IMG' && node.querySelector(BLOCK_SELECTOR));
            if (!isBlock) {
                runs.push(...DocxGenerator._extractRuns(node, fmt, para.size));
                continue;
            }

            flush();
            if (tag === 'TABLE') {
                out.push(DocxGenerator._convertTable(node, fmt));
            } else if (tag === 'UL' || tag === 'OL') {
                DocxGenerator._list(node, fmt, para, out);
            } else if (tag === 'HR') {
                out.push('    <w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>');
            } else if (tag === 'SECTION' && node.dataset?.page && pkg && !para.cell) {
                // A page of its own size and margins (from a PDF): a Word section.
                // Content before it keeps the page it was written on.
                if (out.length > pkg.markAt) {
                    pkg.sections.push(pkg.page);
                    out.push(`${SECTION_MARK}${pkg.sections.length - 1}`);
                }
                pkg.page = DocxGenerator._sectionOf(node);
                pkg.sections.push(pkg.page);
                DocxGenerator._blocks(node, fmt, para, out);
                out.push(`${SECTION_MARK}${pkg.sections.length - 1}`);
                pkg.markAt = out.length;
                pkg.page = PAGE;
            } else {
                const childFmt = DocxGenerator._inlineFormat(node, fmt, para.size);
                const childPara = DocxGenerator._blockFormat(node, para, childFmt);
                const before = out.length;
                DocxGenerator._blocks(node, childFmt, childPara, out);
                // An empty paragraph is the author's vertical space.
                if (out.length === before && tag === 'P') out.push(DocxGenerator._paragraph([], childPara));
            }
        }
        flush();
    }

    /**
     * Each item's first paragraph carries the number; later ones in the
     * same item indent with it, as a browser draws them.
     */
    static _list(listEl, fmt, para, out) {
        const ilvl = para.num ? Math.min(para.num.ilvl + 1, 8) : 0;
        const declared = (listEl.style?.listStyleType || '').toLowerCase();
        const type = LIST_FORMATS[declared] ? declared
            : listEl.tagName === 'OL' ? (OL_TYPES[listEl.getAttribute('type')] || 'decimal')
                : ['disc', 'circle', 'square'][ilvl % 3];
        const [format, text] = LIST_FORMATS[type];
        const start = Number(listEl.getAttribute('start')) || 1;
        pkg.lists.push({ format, text, start });
        const numId = pkg.lists.length;

        for (const item of listEl.children) {
            const itemFmt = DocxGenerator._inlineFormat(item, fmt, para.size);
            const itemPara = { ...DocxGenerator._blockFormat(item, para, itemFmt), num: { numId, ilvl, used: false } };
            if (item.tagName === 'UL' || item.tagName === 'OL') {
                DocxGenerator._list(item, fmt, { ...para, num: { numId, ilvl, used: true } }, out);
                continue;
            }
            const before = out.length;
            DocxGenerator._blocks(item, itemFmt, itemPara, out);
            if (out.length === before) out.push(DocxGenerator._paragraph([], itemPara));
        }
    }

    /**
     * Paragraph formatting a block element adds to what it inherits. Run
     * formatting is not inherited here; `_inlineFormat` carries it.
     * @param {Element} el
     * @param {ParaFormat} parent
     * @param {RunFormat} fmt  The element's own run format, for its font size.
     * @returns {ParaFormat}
     */
    static _blockFormat(el, parent, fmt) {
        const s = el.style;
        const size = fmt.size || parent.size || BASE_SIZE;
        // Spacing belongs to one block, not to the blocks inside it.
        const para = { ...parent, size, before: undefined, after: parent.cell ? 0 : undefined, tabs: undefined };
        const tag = el.tagName;

        if (/^H[1-6]$/.test(tag)) para.style = `Heading${tag[1]}`;
        if (tag === 'BLOCKQUOTE') para.left = (para.left || 0) + 720;
        if (tag === 'DD') para.left = (para.left || 0) + 720;
        if (tag === 'CENTER') para.align = 'center';

        const align = (s?.textAlign || el.getAttribute('align') || '').toLowerCase();
        const jc = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', justify: 'both' }[align];
        if (jc) para.align = jc;
        // A cell's padding and background are the cell's (tcPr), not its text's.
        if (tag === 'TD' || tag === 'TH') return para;

        const length = (prop) => DocxGenerator._twips(s?.getPropertyValue(prop), size);
        const left = (length('margin-left') || 0) + (length('padding-left') || 0);
        if (left > 0) para.left = (para.left || 0) + left;
        const indent = length('text-indent');
        if (indent !== null) para.firstLine = indent;
        const before = Math.max(length('margin-top') || 0, length('padding-top') || 0);
        const after = Math.max(length('margin-bottom') || 0, length('padding-bottom') || 0);
        if (s?.marginTop || s?.paddingTop) para.before = before;
        if (s?.marginBottom || s?.paddingBottom) para.after = after;

        const lh = (s?.lineHeight || '').trim();
        if (/^[\d.]+$/.test(lh)) {
            para.line = Math.round(240 * Number(lh));
            para.lineRule = 'auto';
        } else if (/%$/.test(lh)) {
            para.line = Math.round(2.4 * parseFloat(lh));
            para.lineRule = 'auto';
        } else {
            const exact = DocxGenerator._twips(lh, size);
            if (exact) {
                para.line = exact;
                // CSS has no 'at least'; Word's own HTML names its rule beside the height.
                para.lineRule = /mso-line-height-rule:\s*exactly/i.test(el.getAttribute('style') || '') ? 'exact' : 'atLeast';
            }
        }

        // Tab stops from the left text edge, in points (lib/pdf-layout.js).
        const tabs = String(el.dataset?.tabs || '').split(/\s+/).map(Number).filter((v) => Number.isFinite(v) && v > 0);
        if (tabs.length) para.tabs = tabs.map((v) => Math.round(v * 20));

        const fill = DocxGenerator._color(s?.backgroundColor);
        if (fill) para.fill = fill;
        return para;
    }

    /**
     * @param {Run[]} runs
     * @param {ParaFormat} para
     * @returns {string}
     */
    static _paragraph(runs, para) {
        const p = [];
        if (para.style) p.push(`<w:pStyle w:val="${para.style}"/>`);
        if (para.num && !para.num.used) {
            p.push(`<w:numPr><w:ilvl w:val="${para.num.ilvl}"/><w:numId w:val="${para.num.numId}"/></w:numPr>`);
        }
        if (para.fill) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${para.fill}"/>`);
        if (para.tabs) p.push(`<w:tabs>${para.tabs.map((pos) => `<w:tab w:val="left" w:pos="${pos}"/>`).join('')}</w:tabs>`);

        const spacing = [];
        if (para.before !== undefined) spacing.push(`w:before="${para.before}"`);
        if (para.after !== undefined) spacing.push(`w:after="${para.after}"`);
        if (para.line) spacing.push(`w:line="${para.line}" w:lineRule="${para.lineRule}"`);
        if (spacing.length) p.push(`<w:spacing ${spacing.join(' ')}/>`);

        // A numbered paragraph takes the list's indent; a later one in the
        // same item lines up with the item's text.
        const listLeft = para.num ? LIST_INDENT * (para.num.ilvl + 1) : 0;
        const left = (para.left || 0) + listLeft;
        const ind = [];
        if (left && !(para.num && !para.num.used && !para.left)) ind.push(`w:left="${left}"`);
        if (para.firstLine > 0) ind.push(`w:firstLine="${para.firstLine}"`);
        else if (para.firstLine < 0) ind.push(`w:hanging="${-para.firstLine}"`);
        if (ind.length) p.push(`<w:ind ${ind.join(' ')}/>`);
        if (para.align) p.push(`<w:jc w:val="${para.align}"/>`);
        if (para.num) para.num.used = true;

        const pPr = p.length ? `<w:pPr>${p.join('')}</w:pPr>` : '';
        return `    <w:p>${pPr}${DocxGenerator._runsXml(runs)}</w:p>`;
    }

    /** Runs to XML, consecutive runs of one link inside one hyperlink. */
    static _runsXml(runs) {
        let xml = '';
        let link = null;
        for (const run of runs) {
            if ((run.fmt.link || null) !== link) {
                if (link) xml += '</w:hyperlink>';
                link = run.fmt.link || null;
                if (link) xml += `<w:hyperlink r:id="${link}" w:history="1">`;
            }
            xml += DocxGenerator._runXml(run);
        }
        if (link) xml += '</w:hyperlink>';
        return xml;
    }

    // ─── Inline content ─────────────────────────────────

    /**
     * Formatted runs from an inline element and everything inside it.
     * @param {Element} el
     * @param {RunFormat} inherit
     * @param {number} [size]  The paragraph's font size, half-points.
     * @returns {Run[]}
     */
    static _extractRuns(el, inherit = {}, size = BASE_SIZE) {
        // A kept OLE object: its HTML stand-in is not the content.
        if (el.dataset?.ole !== undefined) return [{ text: '', ole: Number(el.dataset.ole), fmt: inherit }];
        const tag = el.tagName;
        if (tag === 'IMG') {
            const src = el.getAttribute('src') || '';
            return src.startsWith('data:')
                ? [{ text: '', image: src, width: Number(el.getAttribute('width')) || 0, float: el.dataset?.float, shift: DocxGenerator._twips(el.style?.verticalAlign), fmt: inherit }]
                : [];
        }
        if (tag === 'BR') return [{ text: '', br: true, fmt: inherit }];
        if (el.dataset?.tab !== undefined) return [{ text: '', tab: true, fmt: inherit }];
        if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'COLGROUP', 'COL'].includes(tag)) return [];

        const fmt = DocxGenerator._inlineFormat(el, inherit, size);
        const runs = [];
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) runs.push(...DocxGenerator._textRuns(node.textContent, fmt));
            else if (node.nodeType === Node.ELEMENT_NODE) runs.push(...DocxGenerator._extractRuns(node, fmt, fmt.size || size));
        }
        return runs;
    }

    /**
     * Text as runs: whitespace collapses as a browser collapses it, except
     * in preformatted text, whose breaks and tabs are kept.
     * @returns {Run[]}
     */
    static _textRuns(text, fmt) {
        if (!text) return [];
        if (!fmt.pre) {
            const collapsed = text.replace(/[ \t\n\r\f]+/g, ' ');
            return collapsed ? [{ text: collapsed, fmt }] : [];
        }
        const runs = [];
        text.split('\n').forEach((line, i) => {
            if (i > 0) runs.push({ text: '', br: true, fmt });
            line.split('\t').forEach((part, j) => {
                if (j > 0) runs.push({ text: '', tab: true, fmt });
                if (part) runs.push({ text: part, fmt });
            });
        });
        return runs;
    }

    /**
     * Drops the spaces a browser would not draw: at either end of the
     * paragraph and the second of two meeting across runs. Edits in place.
     * @param {Run[]} runs
     * @returns {Run[]} The runs left, empty when nothing would show.
     */
    static _trimRuns(runs) {
        let prevSpace = true;
        for (const run of runs) {
            if (run.br || run.tab || run.image || run.ole !== undefined) {
                prevSpace = Boolean(run.br);
                continue;
            }
            if (run.fmt.pre) { prevSpace = false; continue; }
            if (prevSpace) run.text = run.text.replace(/^ /, '');
            if (run.text) prevSpace = run.text.endsWith(' ');
        }
        for (let i = runs.length - 1; i >= 0; i--) {
            const run = runs[i];
            if (run.br || run.tab || run.image || run.ole !== undefined || run.fmt.pre) break;
            run.text = run.text.replace(/ $/, '');
            if (run.text) break;
        }
        const kept = runs.filter((r) => r.text || r.br || r.tab || r.image || r.ole !== undefined);
        runs.splice(0, runs.length, ...kept);
        // Line breaks alone draw nothing.
        return runs.some((r) => !r.br) ? runs : [];
    }

    /**
     * Run formatting an element adds to what it inherits, from its tag and
     * its inline style.
     * @param {Element} el
     * @param {RunFormat} inherit
     * @param {number} size  The inherited font size, half-points.
     * @returns {RunFormat}
     */
    static _inlineFormat(el, inherit, size) {
        const fmt = { ...inherit };
        const tag = el.tagName;
        const s = el.style;

        if (tag === 'B' || tag === 'STRONG' || tag === 'TH') fmt.bold = true;
        if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN' || tag === 'VAR') fmt.italic = true;
        if (tag === 'U' || tag === 'INS') fmt.underline = true;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') fmt.strike = true;
        if (tag === 'SUP') fmt.script = 'sup';
        if (tag === 'SUB') fmt.script = 'sub';
        if (tag === 'MARK') fmt.highlight = 'yellow';
        if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT' || tag === 'PRE') fmt.font = 'Courier New';
        if (tag === 'PRE') fmt.pre = true;
        if (tag === 'SMALL') fmt.size = Math.round((fmt.size || size) * 0.83);
        if (tag === 'BIG') fmt.size = Math.round((fmt.size || size) * 1.2);
        if (tag === 'A') {
            const href = (el.getAttribute('href') || '').trim();
            if (/^(https?:|mailto:)/i.test(href) && pkg) {
                if (!pkg.links.has(href)) {
                    const id = `rIdLink${pkg.links.size + 1}`;
                    pkg.links.set(href, id);
                    pkg.rels.push({ id, type: REL_LINK, target: href, external: true });
                }
                fmt.link = pkg.links.get(href);
            }
        }
        if (!s) return fmt;

        const weight = (s.fontWeight || '').toLowerCase();
        if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) fmt.bold = true;
        else if (weight === 'normal' || weight === 'lighter' || (Number(weight) > 0 && Number(weight) < 600)) fmt.bold = false;

        const style = (s.fontStyle || '').toLowerCase();
        if (style === 'italic' || style === 'oblique') fmt.italic = true;
        else if (style === 'normal') fmt.italic = false;

        const decoration = `${s.textDecorationLine || ''} ${s.textDecoration || ''}`.toLowerCase();
        if (decoration.includes('underline')) fmt.underline = true;
        if (decoration.includes('line-through')) fmt.strike = true;

        const valign = (s.verticalAlign || '').toLowerCase();
        if (valign === 'super') fmt.script = 'sup';
        else if (valign === 'sub') fmt.script = 'sub';
        else if (valign === 'baseline') fmt.script = null;

        const fontSize = DocxGenerator._halfPoints(s.fontSize, fmt.size || size);
        // Word shrinks a superscript itself; the browser's smaller size would shrink it twice.
        if (fontSize && !(fmt.script && fontSize < (inherit.size || size))) fmt.size = fontSize;

        const color = DocxGenerator._color(s.color);
        if (color) fmt.color = color;
        const fill = DocxGenerator._color(s.backgroundColor);
        if (fill && tag !== 'TD' && tag !== 'TH' && !BLOCK_TAGS.has(tag)) fmt.fill = fill;

        const family = DocxGenerator._fontFamily(s.fontFamily);
        if (family) fmt.font = family;

        if ((s.fontVariant || '').toLowerCase().includes('small-caps')) fmt.smallCaps = true;
        const transform = (s.textTransform || '').toLowerCase();
        if (transform === 'uppercase') fmt.caps = true;
        else if (transform === 'none') fmt.caps = false;
        return fmt;
    }

    /**
     * One <w:r> (or <m:oMath>): text, a break, a tab, a picture or an OLE object.
     * @param {Run} run
     */
    static _runXml(run) {
        const rPr = DocxGenerator._rPr(run.fmt);

        if (run.image) return DocxGenerator._imageXml(run.image, run.width, run.float, run.shift);

        if (run.ole !== undefined) {
            // A converted equation is an <m:oMath>, a sibling of runs, not a run.
            const omml = pkg?.ole?.[run.ole]?.omml;
            if (omml) return omml;
            return `<w:r>${rPr}${DocxGenerator._oleXml(run.ole)}</w:r>`;
        }
        if (run.br) return `<w:r>${rPr}<w:br/></w:r>`;
        if (run.tab) return `<w:r>${rPr}<w:tab/></w:r>`;

        return `<w:r>${rPr}<w:t xml:space="preserve">${DocxGenerator._escapeXml(run.text)}</w:t></w:r>`;
    }

    /** @param {RunFormat} f  In the element order the schema requires. */
    static _rPr(f = {}) {
        const p = [];
        if (f.link) p.push('<w:rStyle w:val="Hyperlink"/>');
        if (f.font) {
            const font = DocxGenerator._escapeXml(f.font);
            p.push(`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`);
        }
        if (f.bold) p.push('<w:b/><w:bCs/>');
        if (f.italic) p.push('<w:i/><w:iCs/>');
        if (f.caps) p.push('<w:caps/>');
        if (f.smallCaps) p.push('<w:smallCaps/>');
        if (f.strike) p.push('<w:strike/>');
        if (f.color) p.push(`<w:color w:val="${f.color}"/>`);
        if (f.size) p.push(`<w:sz w:val="${f.size}"/><w:szCs w:val="${f.size}"/>`);
        if (f.highlight) p.push(`<w:highlight w:val="${f.highlight}"/>`);
        if (f.underline) p.push('<w:u w:val="single"/>');
        if (f.fill) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${f.fill}"/>`);
        if (f.script) p.push(`<w:vertAlign w:val="${f.script === 'sup' ? 'superscript' : 'subscript'}"/>`);
        return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
    }

    // ─── CSS values ─────────────────────────────────────

    /**
     * A CSS length in twips, or null when absent or not absolute.
     * @param {string} value
     * @param {number} size  Font size in half-points, for `em`.
     */
    static _twips(value, size = BASE_SIZE) {
        const m = String(value || '').trim().match(/^(-?[\d.]+)(pt|px|cm|mm|in|em|rem)?$/i);
        if (!m) return null;
        const n = Number(m[1]);
        if (!Number.isFinite(n)) return null;
        const unit = (m[2] || 'px').toLowerCase();
        const factor = { pt: 20, px: 15, cm: 567, mm: 56.7, in: 1440, em: size * 10, rem: BASE_SIZE * 10 }[unit];
        return Math.round(n * factor);
    }

    /** A CSS font size in half-points, or null. */
    static _halfPoints(value, size = BASE_SIZE) {
        const v = String(value || '').trim().toLowerCase();
        let hp = null;
        const m = v.match(/^([\d.]+)(pt|px|em|rem|%)$/);
        if (m) {
            const n = Number(m[1]);
            hp = { pt: n * 2, px: n * 1.5, em: n * size, rem: n * BASE_SIZE, '%': n * size / 100 }[m[2]];
        } else if (v === 'smaller') hp = size * 0.83;
        else if (v === 'larger') hp = size * 1.2;
        if (!hp || !Number.isFinite(hp)) return null;
        return Math.max(2, Math.min(3276, Math.round(hp)));
    }

    /** A CSS colour as RRGGBB, or null when absent or transparent. */
    static _color(value) {
        const v = String(value || '').trim().toLowerCase();
        if (!v || v === 'transparent' || v === 'inherit' || v === 'initial' || v === 'currentcolor') return null;
        const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
        if (rgb) {
            const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : Number(rgb[4]);
            if (alpha === 0) return null;
            return [rgb[1], rgb[2], rgb[3]].map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('').toUpperCase();
        }
        const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
        if (hex) {
            const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
            return h.toUpperCase();
        }
        return NAMED_COLORS[v] || null;
    }

    /** The first family of a CSS `font-family`, generic ones named for Word. */
    static _fontFamily(value) {
        const first = String(value || '').split(',')[0].trim().replace(/^["']|["']$/g, '').trim();
        if (!first || /^(inherit|initial|unset|system-ui|-apple-system)$/i.test(first)) return null;
        return GENERIC_FONTS[first.toLowerCase()] || first;
    }

    // ─── Pictures and objects ───────────────────────────

    /**
     * An inline picture from a `data:` URL, sized from its `width` attribute
     * or its own pixels, at its own aspect ratio.
     * @param {string} dataUrl
     * @param {number} widthAttr  CSS pixels, 0 when absent.
     * @param {string} [float]  `x y` in points from the page's top left: the
     *   picture is placed there, over the text, rather than in the line.
     * @param {number|null} [shift]  Twips the picture is raised (lowered when
     *   negative) from the baseline, from its CSS `vertical-align`.
     * @returns {string} A <w:r>, or '' when the data is not a picture Word reads.
     */
    static _imageXml(dataUrl, widthAttr, float, shift) {
        const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
        const ext = match && IMAGE_EXT[match[1].toLowerCase()];
        if (!ext || !pkg) return '';

        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        const size = DocxGenerator._pixelSize(bytes);
        if (!size) return '';
        const page = pkg.page || PAGE;
        // Inline, a picture fits the text width; placed, the page.
        const maxPx = Math.floor((float ? page.width : DocxGenerator._textWidth()) / 15);
        const width = Math.min(widthAttr || size.width, maxPx);
        const height = Math.round(width * size.height / size.width);
        const cx = Math.round(width * EMU_PER_PX);
        const cy = Math.round(height * EMU_PER_PX);

        const n = pkg.files.filter((f) => f.path.startsWith('word/media/image')).length + 1;
        const rid = `rIdImage${n}`;
        pkg.rels.push({ id: rid, type: REL_IMAGE, target: `media/image${n}.${ext}` });
        pkg.files.push({ path: `word/media/image${n}.${ext}`, base64: match[2] });
        pkg.exts.add(ext);

        const graphic = `<wp:docPr id="${n}" name="Picture ${n}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
            `</pic:pic></a:graphicData></a:graphic>`;

        const [x, y] = String(float || '').split(/\s+/).map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + n}" ` +
                `behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>` +
                `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(x * EMU_PER_PT)}</wp:posOffset></wp:positionH>` +
                `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(y * EMU_PER_PT)}</wp:posOffset></wp:positionV>` +
                `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>${graphic}</wp:anchor></w:drawing></w:r>`;
        }
        // w:position counts half-points.
        const rPr = shift ? `<w:rPr><w:position w:val="${Math.round(shift / 10)}"/></w:rPr>` : '';
        return `<w:r>${rPr}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>${graphic}</wp:inline></w:drawing></w:r>`;
    }

    /**
     * Pixel size from a PNG, GIF, BMP or JPEG header.
     * @param {Uint8Array} b
     * @returns {{width: number, height: number}|null}
     */
    static _pixelSize(b) {
        const be16 = (i) => (b[i] << 8) | b[i + 1];
        const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
        const le16 = (i) => b[i] | (b[i + 1] << 8);
        const le32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
        let size = null;
        if (b[0] === 0x89 && b[1] === 0x50) size = { width: be32(16), height: be32(20) };
        else if (b[0] === 0x47 && b[1] === 0x49) size = { width: le16(6), height: le16(8) };
        else if (b[0] === 0x42 && b[1] === 0x4D) size = { width: le32(18), height: Math.abs(le32(22) | 0) };
        else if (b[0] === 0xFF && b[1] === 0xD8) {
            // Walk the segments to the frame header (SOF0-SOF15, bar DHT/JPG/DAC).
            for (let i = 2; i + 9 < b.length;) {
                if (b[i] !== 0xFF) { i++; continue; }
                const marker = b[i + 1];
                if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
                    size = { width: be16(i + 7), height: be16(i + 5) };
                    break;
                }
                i += 2 + be16(i + 2);
            }
        }
        return size && size.width > 0 && size.height > 0 ? size : null;
    }

    /**
     * The original <w:object>, its .bin and its preview written back as new
     * parts. An index with no object degrades to the mark the HTML showed.
     * @param {number} index
     * @returns {string}
     */
    static _oleXml(index) {
        const obj = pkg?.ole?.[index];
        if (!obj || typeof obj.xml !== 'string' || !obj.bin) return '<w:t>[■]</w:t>';

        const n = pkg.files.filter((f) => f.path.endsWith('.bin')).length + 1;
        const binRid = `rIdOle${n}`;
        pkg.rels.push({ id: binRid, type: REL_OLE, target: `embeddings/oleObject${n}.bin` });
        pkg.files.push({ path: `word/embeddings/oleObject${n}.bin`, base64: obj.bin });
        pkg.exts.add('bin');

        let xml = obj.xml.replace(OLE_PLACEHOLDERS.BIN_RID, binRid);
        if (obj.preview && MEDIA_TYPES[obj.previewExt]) {
            const previewRid = `rIdOlePreview${n}`;
            pkg.rels.push({ id: previewRid, type: REL_IMAGE, target: `media/ole${n}.${obj.previewExt}` });
            pkg.files.push({ path: `word/media/ole${n}.${obj.previewExt}`, base64: obj.preview });
            pkg.exts.add(obj.previewExt);
            xml = xml.replace(OLE_PLACEHOLDERS.PREVIEW_RID, previewRid);
        }

        // The shapetype rides inside the first object, as Word writes it.
        return n === 1 ? xml.replace(/^(<w:object\b[^>]*>)/, `$1${OLE_SHAPETYPE}`) : xml;
    }

    // ─── Tables ─────────────────────────────────────────

    /**
     * An HTML table as a Word table on a real grid: colspan becomes
     * gridSpan, rowspan a vertical merge, and each cell keeps its paragraphs.
     * @param {HTMLTableElement} tableEl
     * @param {RunFormat} fmt
     */
    static _convertTable(tableEl, fmt) {
        const rows = [...tableEl.rows];
        if (!rows.length) return '';

        // Lay every cell on the grid first: a rowspan reserves columns below it.
        const active = [];
        const laid = rows.map((row) => {
            const entries = [];
            const cells = [...row.cells];
            let col = 0;
            while (cells.length > 0 || active.some((a, i) => i >= col && a?.rows > 0)) {
                const merged = active[col];
                if (merged?.rows > 0) {
                    entries.push({ col, span: merged.span, cont: true, cell: merged.cell });
                    merged.rows--;
                    col += merged.span;
                    continue;
                }
                if (cells.length === 0) { col++; continue; }
                const cell = cells.shift();
                const span = Math.max(1, Math.min(63, Number(cell.getAttribute('colspan')) || 1));
                const rowspan = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
                entries.push({ col, span, cell, restart: rowspan > 1 });
                if (rowspan > 1) active[col] = { rows: rowspan - 1, span, cell };
                col += span;
            }
            return { row, entries, end: col };
        });
        const columns = Math.max(1, ...laid.map((r) => r.end));
        const widths = DocxGenerator._columnWidths(tableEl, laid, columns);
        const sum = (col, span) => widths.slice(col, col + span).reduce((a, b) => a + b, 0);

        // Borders drawn per cell when the HTML says where they are; else a grid.
        const styled = [...tableEl.querySelectorAll('td, th')].some((c) => /border/.test(c.getAttribute('style') || ''));
        const grid = styled ? 'nil' : 'single';
        const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
            .map((side) => grid === 'nil' ? `<w:${side} w:val="nil"/>` : `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
            .join('');

        const indent = DocxGenerator._twips(tableEl.style?.marginLeft);
        const tblInd = indent ? `<w:tblInd w:w="${indent}" w:type="dxa"/>` : '';
        const layout = tableEl.style?.tableLayout === 'fixed' ? 'fixed' : 'autofit';
        let xml = `    <w:tbl>\n      <w:tblPr><w:tblW w:w="${sum(0, columns)}" w:type="dxa"/>` +
            `${DocxGenerator._tableAlign(tableEl)}${tblInd}<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="${layout}"/>` +
            `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>\n` +
            `      <w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>\n`;

        for (const { row, entries, end } of laid) {
            const height = DocxGenerator._twips(row.style?.height);
            const trPr = [
                height > 0 ? `<w:trHeight w:val="${height}" w:hRule="atLeast"/>` : '',
                row.parentElement?.tagName === 'THEAD' ? '<w:tblHeader/>' : '',
            ].join('');
            xml += `      <w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}\n`;
            for (const entry of entries) {
                xml += `        ${DocxGenerator._cell(entry, sum(entry.col, entry.span), fmt, styled)}\n`;
            }
            // Short rows are padded, so every row spans the grid.
            for (let col = end; col < columns; col++) {
                xml += `        <w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>\n`;
            }
            xml += '      </w:tr>\n';
        }

        xml += '    </w:tbl>';
        return xml;
    }

    /** A <w:tc>: its merge, width, borders, shading, alignment and paragraphs. */
    static _cell({ cell, span, cont, restart }, width, fmt, styled) {
        const s = cell.style;
        const pr = [`<w:tcW w:w="${width}" w:type="dxa"/>`];
        if (span > 1) pr.push(`<w:gridSpan w:val="${span}"/>`);
        if (restart) pr.push('<w:vMerge w:val="restart"/>');
        else if (cont) pr.push('<w:vMerge/>');
        if (styled) pr.push(DocxGenerator._cellBorders(s));
        const fill = DocxGenerator._color(s?.backgroundColor);
        if (fill) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
        // Padding the HTML states is the cell's margin; else the table style's.
        const margins = ['top', 'left', 'bottom', 'right']
            .map((side) => [side, s?.getPropertyValue(`padding-${side}`) ? DocxGenerator._twips(s.getPropertyValue(`padding-${side}`)) : null])
            .filter(([, w]) => w !== null && w >= 0);
        if (margins.length) pr.push(`<w:tcMar>${margins.map(([side, w]) => `<w:${side} w:w="${w}" w:type="dxa"/>`).join('')}</w:tcMar>`);
        const valign = { top: 'top', middle: 'center', bottom: 'bottom' }[(s?.verticalAlign || cell.getAttribute('valign') || '').toLowerCase()];
        if (valign) pr.push(`<w:vAlign w:val="${valign}"/>`);
        const tcPr = `<w:tcPr>${pr.join('')}</w:tcPr>`;
        // Under a merge: a paragraph too small to make the row taller.
        if (cont) return `<w:tc>${tcPr}<w:p><w:pPr>${CARRIER_PPR}</w:pPr></w:p></w:tc>`;

        const out = [];
        const cellFmt = DocxGenerator._inlineFormat(cell, fmt, BASE_SIZE);
        const cellPara = DocxGenerator._blockFormat(cell, { size: BASE_SIZE, cell: true }, cellFmt);
        if (cell.tagName === 'TH' && !cellPara.align) cellPara.align = 'center';
        DocxGenerator._blocks(cell, cellFmt, cellPara, out);
        // A cell must end in a paragraph, even after a nested table.
        if (out.length === 0 || out[out.length - 1].trimStart().startsWith('<w:tbl>')) out.push('<w:p/>');
        return `<w:tc>${tcPr}${out.map((x) => x.trim()).join('')}</w:tc>`;
    }

    /** The four sides a cell's inline style draws, none where it draws nothing. */
    static _cellBorders(s) {
        const sides = ['top', 'left', 'bottom', 'right'].map((side) => {
            const style = (s?.getPropertyValue(`border-${side}-style`) || '').toLowerCase();
            const width = DocxGenerator._twips(s?.getPropertyValue(`border-${side}-width`)) || 0;
            if (!style || style === 'none' || style === 'hidden' || width <= 0) return `<w:${side} w:val="nil"/>`;
            const val = { dashed: 'dashed', dotted: 'dotted', double: 'double' }[style] || 'single';
            // Twips to eighths of a point.
            const sz = Math.max(2, Math.min(96, Math.round(width * 8 / 20)));
            const color = DocxGenerator._color(s.getPropertyValue(`border-${side}-color`)) || 'auto';
            return `<w:${side} w:val="${val}" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
        });
        return `<w:tcBorders>${sides.join('')}</w:tcBorders>`;
    }

    static _tableAlign(tableEl) {
        const s = tableEl.style;
        const align = (tableEl.getAttribute('align') || '').toLowerCase();
        const centred = align === 'center' || (s?.marginLeft === 'auto' && s?.marginRight === 'auto');
        return centred ? '<w:jc w:val="center"/>' : '';
    }

    /**
     * Column widths in twips: from `<col>` or single-column cells where the
     * HTML gives one, the rest sharing what is left of the text width.
     */
    static _columnWidths(tableEl, laid, columns) {
        const widths = new Array(columns).fill(null);
        const textWidth = DocxGenerator._textWidth();
        const tableWidth = DocxGenerator._lengthOf(tableEl, textWidth) || textWidth;
        // A fixed layout states the page's own geometry: no fitting to the text width.
        const fixed = tableEl.style?.tableLayout === 'fixed';
        const limit = fixed ? Infinity : textWidth;
        const total = Math.min(tableWidth, limit);

        let i = 0;
        for (const col of tableEl.querySelectorAll(':scope > colgroup > col, :scope > col')) {
            const span = Number(col.getAttribute('span')) || 1;
            const w = DocxGenerator._lengthOf(col, total);
            for (let k = 0; k < span && i < columns; k++, i++) if (w) widths[i] = Math.round(w / span);
        }
        for (const { entries } of laid) {
            for (const e of entries) {
                if (e.cont || widths[e.col] !== null) continue;
                const w = DocxGenerator._lengthOf(e.cell, total);
                if (!w) continue;
                if (e.span === 1) widths[e.col] = w;
            }
        }

        const known = widths.reduce((a, w) => a + (w || 0), 0);
        const unknown = widths.filter((w) => w === null).length;
        const share = unknown ? Math.max(360, Math.round((Math.max(total - known, 0) || total) / unknown)) : 0;
        const filled = widths.map((w) => w ?? share);
        // Wider than the page: scale down, keeping the proportions.
        const sum = filled.reduce((a, b) => a + b, 0);
        return sum > limit ? filled.map((w) => Math.max(120, Math.round(w * limit / sum))) : filled;
    }

    /** An element's width (style or attribute) in twips, `%` against `of`. */
    static _lengthOf(el, of) {
        const raw = (el.style?.width || el.getAttribute('width') || '').trim();
        if (/%$/.test(raw)) return Math.round(of * parseFloat(raw) / 100) || null;
        const tw = DocxGenerator._twips(raw);
        return tw && tw > 0 ? tw : null;
    }

    /**
     * Escape special XML characters, and drop the control characters XML 1.0
     * cannot hold at all.
     */
    static _escapeXml(str) {
        return String(str)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
