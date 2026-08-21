/**
 * DocxGenerator — Converts cleaned HTML into a proper .docx file
 * (Office Open XML / OOXML format, Office 2007+).
 *
 * A .docx is a ZIP containing XML files:
 *   [Content_Types].xml
 *   _rels/.rels
 *   word/document.xml    ← the actual content
 *   word/_rels/document.xml.rels
 *   word/styles.xml      ← heading/body styles
 */

import { MiniZip } from './mini-zip.js';

export class DocxGenerator {

    /**
     * Generate a .docx Blob from HTML content.
     * @param {string} html       Cleaned HTML (body innerHTML only, no <html> wrapper)
     * @param {string} [title]    Document title
     * @returns {Blob}            .docx file as Blob
     */
    static generate(html, title = 'Document') {
        const zip = new MiniZip();

        // ── Package metadata ─────────────────────────────
        zip.addFile('[Content_Types].xml', DocxGenerator._contentTypes());
        zip.addFile('_rels/.rels', DocxGenerator._rootRels());
        zip.addFile('word/_rels/document.xml.rels', DocxGenerator._docRels());
        zip.addFile('word/styles.xml', DocxGenerator._styles());
        zip.addFile('word/document.xml', DocxGenerator._document(html, title));

        return zip.toBlob();
    }

    // ─── XML Templates ──────────────────────────────────

    static _contentTypes() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
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

    static _docRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
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

        // Runs
        const runXml = runs.map(run => {
            const bold = run.bold || overrideFmt?.bold;
            const italic = run.italic || overrideFmt?.italic;
            const underline = run.underline || overrideFmt?.underline;

            let rPr = '';
            const rPrParts = [];
            if (bold) rPrParts.push('<w:b/>');
            if (italic) rPrParts.push('<w:i/>');
            if (underline) rPrParts.push('<w:u w:val="single"/>');
            if (rPrParts.length) rPr = `<w:rPr>${rPrParts.join('')}</w:rPr>`;

            const escaped = DocxGenerator._escapeXml(run.text);

            // Handle line breaks within runs
            if (run.text === '\n') {
                return `<w:r>${rPr}<w:br/></w:r>`;
            }

            // Preserve leading/trailing spaces
            return `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
        }).join('');

        return `    <w:p>${pPr}${runXml}</w:p>`;
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
                    ? runs.map(r => {
                        let rPr = '';
                        const parts = [];
                        if (r.bold) parts.push('<w:b/>');
                        if (r.italic) parts.push('<w:i/>');
                        if (r.underline) parts.push('<w:u w:val="single"/>');
                        if (parts.length) rPr = `<w:rPr>${parts.join('')}</w:rPr>`;
                        return `<w:r>${rPr}<w:t xml:space="preserve">${DocxGenerator._escapeXml(r.text)}</w:t></w:r>`;
                    }).join('')
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
