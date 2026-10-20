/**
 * Cleaned HTML to .docx (OOXML, Office 2007+) — a ZIP of [Content_Types].xml,
 * _rels/.rels, word/document.xml, word/_rels/document.xml.rels, word/styles.xml,
 * plus word/media/ for pictures and word/embeddings/ for kept OLE objects.
 * Only `data:` pictures are written; a linked one would need fetching.
 *
 * Lives in popup/ because it parses with `DOMParser` and so needs a realm with
 * a DOM. Its pure dependency, the ZIP writer, stays in lib/zip.js.
 */

import { MiniZip } from '../lib/zip.js';
import { OLE_PLACEHOLDERS } from '../lib/const.js';

const REL_OLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

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

/** Widest picture written, in CSS pixels: the text width of a Letter page. */
const MAX_IMAGE_PX = 624;

/** The picture-frame shapetype every OLE preview shape names; written once. */
const OLE_SHAPETYPE = '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:formulas><v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/><v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/><v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/></v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>';

/**
 * The package being written. Set only for the duration of one synchronous
 * generate(), so the static run writers can allocate relationships without
 * threading it through every call.
 * @type {{ole: object[], rels: Array<{id: string, type: string, target: string}>, files: Array<{path: string, base64: string}>, exts: Set<string>}|null}
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
        pkg = { ole, rels: [], files: [], exts: new Set() };

        try {
            // document.xml first: writing it is what allocates the OLE parts.
            const documentXml = DocxGenerator._document(html, title);

            zip.addFile('[Content_Types].xml', DocxGenerator._contentTypes(pkg.exts));
            zip.addFile('_rels/.rels', DocxGenerator._rootRels());
            zip.addFile('word/_rels/document.xml.rels', DocxGenerator._docRels(pkg.rels));
            zip.addFile('word/styles.xml', DocxGenerator._styles());
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

    /** @param {Set<string>} [exts]  Extensions of the binary parts written. */
    static _contentTypes(exts = new Set()) {
        const defaults = [...exts]
            .filter((ext) => MEDIA_TYPES[ext])
            .map((ext) => `\n  <Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext]}"/>`)
            .join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>${defaults}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
    }

    static _rootRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    }

    /** @param {Array<{id: string, type: string, target: string}>} [extra] */
    static _docRels(extra = []) {
        const rels = extra
            .map((r) => `\n  <Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
            .join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels}
</Relationships>`;
    }

    static _styles() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="160" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="360" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="280" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
</w:styles>`;
    }

    /**
     * Convert cleaned HTML into WordprocessingML body content.
     * @param {string} html
     * @param {string} title
     * @returns {string}  Complete document.xml
     */
    static _document(html, title) {
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
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;
    }

    /**
     * Parse cleaned HTML and convert to OOXML paragraphs.
     * Uses a temporary DOM parser to walk the HTML structure.
     * @param {string} html
     * @returns {string}  OOXML body content
     */
    static _htmlToOoxml(html) {
        // Parse the HTML in a temporary container
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
        const root = doc.body.querySelector('div') || doc.body;

        const paragraphs = [];

        for (const child of root.children) {
            const tag = child.tagName;

            // Headings
            if (/^H[1-6]$/.test(tag)) {
                const level = parseInt(tag[1]);
                const styleId = level <= 3 ? `Heading${level}` : 'Normal';
                paragraphs.push(DocxGenerator._makeParagraph(
                    DocxGenerator._extractRuns(child),
                    styleId,
                    level > 3 ? { bold: true } : null
                ));
            }
            // Paragraphs and divs
            else if (tag === 'P' || tag === 'DIV') {
                const runs = DocxGenerator._extractRuns(child);
                if (runs.length > 0) {
                    const align = child.style?.textAlign;
                    paragraphs.push(DocxGenerator._makeParagraph(runs, 'Normal', null, align));
                }
            }
            // Lists
            else if (tag === 'UL' || tag === 'OL') {
                const items = child.querySelectorAll('li');
                for (const li of items) {
                    const bullet = tag === 'UL' ? '•  ' : '';
                    const runs = DocxGenerator._extractRuns(li);
                    if (bullet && runs.length > 0) {
                        runs.unshift({ text: bullet, bold: false, italic: false, underline: false });
                    }
                    paragraphs.push(DocxGenerator._makeParagraph(runs, 'Normal', null, null, true));
                }
            }
            // Tables
            else if (tag === 'TABLE') {
                paragraphs.push(DocxGenerator._convertTable(child));
            }
            // Blockquote
            else if (tag === 'BLOCKQUOTE') {
                const runs = DocxGenerator._extractRuns(child);
                paragraphs.push(DocxGenerator._makeParagraph(runs, 'Normal', { italic: true }, null, false, 720));
            }
            // Anything else — try to extract text
            else {
                const text = child.textContent?.trim();
                if (text) {
                    paragraphs.push(DocxGenerator._makeParagraph(
                        [{ text, bold: false, italic: false, underline: false }]
                    ));
                }
            }
        }

        // If no block-level elements found, treat entire HTML as one paragraph
        if (paragraphs.length === 0) {
            const text = root.textContent?.trim();
            if (text) {
                paragraphs.push(DocxGenerator._makeParagraph(
                    [{ text, bold: false, italic: false, underline: false }]
                ));
            }
        }

        return paragraphs.join('\n');
    }

    /**
     * Extract formatted text runs from an element.
     * Walks the children recursively to detect bold, italic, underline.
     * @param {Element} el
     * @param {{ bold: boolean, italic: boolean, underline: boolean }} [inherit]
     * @returns {Array<{ text: string, bold: boolean, italic: boolean, underline: boolean }>}
     */
    static _extractRuns(el, inherit = { bold: false, italic: false, underline: false }) {
        const runs = [];

        for (const node of el.childNodes) {
            // A kept OLE object: its HTML stand-in is not the content.
            if (node.nodeType === Node.ELEMENT_NODE && node.dataset?.ole !== undefined) {
                runs.push({ text: '', ole: Number(node.dataset.ole), ...inherit });
                continue;
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
                const src = node.getAttribute('src') || '';
                if (src.startsWith('data:')) {
                    runs.push({ text: '', image: src, width: Number(node.getAttribute('width')) || 0, ...inherit });
                }
                continue;
            }
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                if (text) {
                    runs.push({ text, ...inherit });
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName;
                const fmt = { ...inherit };

                if (tag === 'B' || tag === 'STRONG') fmt.bold = true;
                if (tag === 'I' || tag === 'EM') fmt.italic = true;
                if (tag === 'U') fmt.underline = true;

                // Check inline styles
                const style = node.style;
                if (style?.fontWeight === 'bold' || style?.fontWeight === '700') fmt.bold = true;
                if (style?.fontStyle === 'italic') fmt.italic = true;
                if (style?.textDecoration?.includes('underline') ||
                    style?.textDecorationLine?.includes('underline')) fmt.underline = true;

                if (tag === 'BR') {
                    runs.push({ text: '\n', ...inherit });
                } else {
                    runs.push(...DocxGenerator._extractRuns(node, fmt));
                }
            }
        }

        return runs;
    }

    /**
     * Build a <w:p> paragraph element.
     */
    static _makeParagraph(runs, styleId = 'Normal', overrideFmt = null, align = null, indent = false, indentTwips = 0) {
        let pPr = '';

        // Paragraph properties
        const pPrParts = [];
        if (styleId && styleId !== 'Normal') {
            pPrParts.push(`<w:pStyle w:val="${styleId}"/>`);
        }
        if (align) {
            const jcMap = { left: 'left', center: 'center', right: 'right', justify: 'both' };
            pPrParts.push(`<w:jc w:val="${jcMap[align] || 'left'}"/>`);
        }
        if (indent || indentTwips) {
            const tw = indentTwips || 360;
            pPrParts.push(`<w:ind w:left="${tw}"/>`);
        }
        if (pPrParts.length > 0) {
            pPr = `<w:pPr>${pPrParts.join('')}</w:pPr>`;
        }

        const runXml = runs.map((run) => DocxGenerator._runXml(run, overrideFmt)).join('');

        return `    <w:p>${pPr}${runXml}</w:p>`;
    }

    /**
     * One <w:r>: text, a line break, or a kept OLE object.
     * @param {{text: string, bold?: boolean, italic?: boolean, underline?: boolean, ole?: number}} run
     * @param {{bold?: boolean, italic?: boolean, underline?: boolean}|null} [overrideFmt]
     */
    static _runXml(run, overrideFmt = null) {
        const rPrParts = [];
        if (run.bold || overrideFmt?.bold) rPrParts.push('<w:b/>');
        if (run.italic || overrideFmt?.italic) rPrParts.push('<w:i/>');
        if (run.underline || overrideFmt?.underline) rPrParts.push('<w:u w:val="single"/>');
        const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';

        if (run.image) return DocxGenerator._imageXml(run.image, run.width);

        if (run.ole !== undefined) {
            // A converted equation is an <m:oMath>, a sibling of runs, not a run.
            const omml = pkg?.ole?.[run.ole]?.omml;
            if (omml) return omml;
            return `<w:r>${rPr}${DocxGenerator._oleXml(run.ole)}</w:r>`;
        }

        // Handle line breaks within runs
        if (run.text === '\n') {
            return `<w:r>${rPr}<w:br/></w:r>`;
        }

        // Preserve leading/trailing spaces
        return `<w:r>${rPr}<w:t xml:space="preserve">${DocxGenerator._escapeXml(run.text)}</w:t></w:r>`;
    }

    /**
     * An inline picture from a `data:` URL, sized from its `width` attribute
     * or its own pixels, at its own aspect ratio.
     * @param {string} dataUrl
     * @param {number} widthAttr  CSS pixels, 0 when absent.
     * @returns {string} A <w:r>, or '' when the data is not a picture Word reads.
     */
    static _imageXml(dataUrl, widthAttr) {
        const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
        const ext = match && IMAGE_EXT[match[1].toLowerCase()];
        if (!ext || !pkg) return '';

        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        const size = DocxGenerator._pixelSize(bytes);
        if (!size) return '';
        const width = Math.min(widthAttr || size.width, MAX_IMAGE_PX);
        const height = Math.round(width * size.height / size.width);
        const cx = Math.round(width * EMU_PER_PX);
        const cy = Math.round(height * EMU_PER_PX);

        const n = pkg.files.filter((f) => f.path.startsWith('word/media/image')).length + 1;
        const rid = `rIdImage${n}`;
        pkg.rels.push({ id: rid, type: REL_IMAGE, target: `media/image${n}.${ext}` });
        pkg.files.push({ path: `word/media/image${n}.${ext}`, base64: match[2] });
        pkg.exts.add(ext);

        return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
            `<wp:docPr id="${n}" name="Picture ${n}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
            `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
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

    /**
     * Convert an HTML table to OOXML table.
     */
    static _convertTable(tableEl) {
        const rows = tableEl.querySelectorAll('tr');
        if (!rows.length) return '';

        let xml = `    <w:tbl>
      <w:tblPr>
        <w:tblStyle w:val="TableGrid"/>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
        </w:tblBorders>
      </w:tblPr>\n`;

        for (const row of rows) {
            xml += '      <w:tr>\n';
            const cells = row.querySelectorAll('td, th');
            for (const cell of cells) {
                const isHeader = cell.tagName === 'TH';
                const runs = DocxGenerator._extractRuns(cell,
                    { bold: isHeader, italic: false, underline: false }
                );
                const cellContent = runs.length > 0
                    ? runs.map((r) => DocxGenerator._runXml(r)).join('')
                    : '<w:r><w:t></w:t></w:r>';

                xml += `        <w:tc><w:p>${cellContent}</w:p></w:tc>\n`;
            }
            xml += '      </w:tr>\n';
        }

        xml += '    </w:tbl>';
        return xml;
    }

    /**
     * Escape special XML characters.
     */
    static _escapeXml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
