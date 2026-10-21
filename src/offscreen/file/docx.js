/**
 * .docx bytes to body HTML. WordprocessingML is read directly: paragraphs,
 * runs, headings, numbering, tables, pictures. Here rather than in lib/
 * because the XML needs DOMParser.
 *
 * Embedded OLE objects are marked `data-ole` for popup/docx.js. A MathType
 * equation is converted to Office Math (editable without MathType) and shown
 * as one line of text in the HTML; anything else is kept whole — its XML,
 * its .bin and its preview — and written back into the exported .docx.
 */
import { MiniUnzip } from '../../lib/unzip.js';
import { MiniZip } from '../../lib/zip.js';
import { escapeHtml } from '../../lib/html.js';
import { isLegacyVnFont } from '../../lib/vnfont.js';
import { readCfbStream } from '../../lib/cfb.js';
import { parseEquationNative } from '../../lib/mtef.js';
import { toOmml, toLinear } from '../../lib/math-render.js';
import { FILE_LIMITS, OLE_PLACEHOLDERS, WARNINGS, WARNING_PREFIXES } from '../../lib/const.js';

const NS = {
    w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    v: 'urn:schemas-microsoft-com:vml',
    o: 'urn:schemas-microsoft-com:office:office',
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    dc: 'http://purl.org/dc/elements/1.1/',
};

/** Marks a picture a browser cannot draw; the warning explains it. */
const SKIPPED_MARK = '[■]';

const EM_SPACE = ' ';

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };

/** EMU per CSS pixel. */
const EMU_PER_PX = 9525;

/** Max displayed picture width, in CSS pixels. */
const MAX_IMAGE_WIDTH = 640;

/**
 * Adobe Symbol code points Word writes as `<w:sym w:char="F0xx">`: the
 * maths and Greek that school material uses.
 */
const SYMBOL = {
    0x22: '∀', 0x24: '∃', 0x44: 'Δ', 0x46: 'Φ', 0x47: 'Γ', 0x4C: 'Λ', 0x50: 'Π', 0x53: 'Σ', 0x57: 'Ω', 0x5E: '⊥',
    0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ', 0x67: 'γ', 0x68: 'η', 0x69: 'ι',
    0x6B: 'κ', 0x6C: 'λ', 0x6D: 'μ', 0x6E: 'ν', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ', 0x73: 'σ', 0x74: 'τ',
    0x75: 'υ', 0x77: 'ω', 0x78: 'ξ', 0x79: 'ψ', 0x7A: 'ζ',
    0xA2: '′', 0xA3: '≤', 0xA5: '∞', 0xAE: '→', 0xB0: '°', 0xB1: '±', 0xB3: '≥', 0xB4: '×', 0xB8: '÷',
    0xB9: '≠', 0xBA: '≡', 0xBB: '≈', 0xC7: '∩', 0xC8: '∪', 0xC9: '⊃', 0xCC: '⊂', 0xCD: '⊆', 0xCE: '∈',
    0xCF: '∉', 0xD0: '∠', 0xD6: '√', 0xDB: '⇔', 0xDE: '⇒', 0xAB: '↔',
};

/**
 * @typedef {{progId: string, omml?: string, linear?: string, xml?: string, bin?: string, preview?: string|null, previewExt?: string|null}} OleObject
 *   A converted equation has `omml` and `linear`. Otherwise `xml` is the
 *   original `<w:object>` with its relationship ids replaced by
 *   OLE_PLACEHOLDERS, and `bin` and `preview` are base64.
 */

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{title: string, text: string, bodyHtml: string, warnings: string[], ole: OleObject[]}>}
 */
export async function parseDocx(bytes) {
    const zip = new MiniUnzip(bytes);
    if (!zip.has('word/document.xml')) {
        throw new Error('The file is a ZIP but not a Word document (.docx).');
    }

    const xml = async (name) => {
        const text = await zip.readText(name);
        return text ? new DOMParser().parseFromString(text, 'application/xml') : null;
    };
    const [doc, rels, numbering, styles, core] = await Promise.all([
        xml('word/document.xml'),
        xml('word/_rels/document.xml.rels'),
        xml('word/numbering.xml'),
        xml('word/styles.xml'),
        xml('docProps/core.xml'),
    ]);

    const ctx = {
        zip,
        rels: relationships(rels),
        numbering: numberingModel(numbering),
        headings: headingStyles(styles),
        counters: new Map(),
        imageBytes: 0,
        skipped: 0,
        after: [],
        /** @type {OleObject[]} */
        ole: [],
        /** Converted MathType `<w:object>`s, swapped in the rewritten package. */
        converted: [],
    };

    const html = [];
    const text = [];
    const body = doc.getElementsByTagNameNS(NS.w, 'body')[0];
    for (const el of body ? body.children : []) {
        await block(el, ctx, html, text);
    }

    const warnings = [];
    if (ctx.skipped > 0) warnings.push(`${WARNING_PREFIXES.DOCX_IMAGES_SKIPPED}:${ctx.skipped}`);
    const converted = ctx.ole.filter((o) => o.omml).length;
    if (converted > 0) warnings.push(`${WARNING_PREFIXES.DOCX_EQUATIONS_CONVERTED}:${converted}`);
    if (ctx.ole.length > converted) warnings.push(`${WARNING_PREFIXES.DOCX_EQUATIONS_KEPT}:${ctx.ole.length - converted}`);
    if (usesLegacyFont(doc) || usesLegacyFont(styles)) warnings.push(WARNINGS.LEGACY_VN_FONT);

    const title = core?.getElementsByTagNameNS(NS.dc, 'title')[0]?.textContent?.trim() || '';
    // Untouched files need no copy: the caller already holds their bytes.
    const docx = ctx.converted.length > 0 ? toBase64(await convertedPackage(zip, doc, ctx.converted)) : null;
    return { title, text: text.join('\n\n'), bodyHtml: html.join('\n'), warnings, ole: ctx.ole, ...(docx ? { docx } : {}) };
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

async function block(el, ctx, html, text) {
    if (el.namespaceURI === NS.w && el.localName === 'p') {
        const p = await paragraph(el, ctx);
        if (p) { html.push(p.html); text.push(p.text); }
        // Text boxes cannot nest inside a paragraph; they follow it.
        const pending = ctx.after.splice(0);
        for (const box of pending) await block(box, ctx, html, text);
    } else if (el.namespaceURI === NS.w && el.localName === 'tbl') {
        const t = await table(el, ctx);
        html.push(t.html);
        text.push(t.text);
    } else if (el.namespaceURI === NS.w && (el.localName === 'sdt' || el.localName === 'sdtContent' || el.localName === 'txbxContent' || el.localName === 'customXml')) {
        for (const child of el.children) await block(child, ctx, html, text);
    }
}

async function paragraph(p, ctx) {
    const pPr = child(p, 'pPr');
    const styleId = val(child(pPr, 'pStyle'));
    const level = ctx.headings.get(styleId) || outlineLevel(pPr);
    const jc = val(child(pPr, 'jc'));
    const prefix = numberPrefix(child(pPr, 'numPr'), ctx);

    const runs = await inline(p, ctx);
    const inner = (prefix ? escapeHtml(prefix) + ' ' : '') + runs.html;
    const plain = ((prefix ? prefix + ' ' : '') + runs.text).trim();
    if (!plain && !/<img\b/.test(runs.html)) return null;

    const tag = level ? `h${Math.min(level, 6)}` : 'p';
    const align = { center: 'center', right: 'right', end: 'right', both: 'justify' }[jc];
    const attr = align ? ` style="text-align:${align}"` : '';
    return { html: `<${tag}${attr}>${inner}</${tag}>`, text: plain };
}

async function table(tbl, ctx) {
    const rows = [];
    const textRows = [];
    for (const tr of children(tbl, 'tr')) {
        const cells = [];
        const textCells = [];
        for (const tc of children(tr, 'tc')) {
            const tcPr = child(tc, 'tcPr');
            const span = Number(val(child(tcPr, 'gridSpan'))) || 1;
            const parts = [];
            const texts = [];
            for (const el of tc.children) await block(el, ctx, parts, texts);
            // Paragraph tags inside a cell paste poorly, so lines break instead.
            const inner = parts.map((h) => h.replace(/^<(p|h\d)[^>]*>|<\/(p|h\d)>$/g, '')).join('<br>');
            cells.push(`<td${span > 1 ? ` colspan="${span}"` : ''}>${inner}</td>`);
            textCells.push(texts.join(' '));
        }
        rows.push(`<tr>${cells.join('')}</tr>`);
        textRows.push(textCells.join('\t'));
    }
    return { html: `<table>${rows.join('')}</table>`, text: textRows.join('\n') };
}

// ─── Inline content ─────────────────────────────────────────────────────────

/** @returns {Promise<{html: string, text: string}>} */
async function inline(parent, ctx) {
    let html = '';
    let text = '';
    for (const el of parent.children) {
        const part = await inlineNode(el, ctx);
        html += part.html;
        text += part.text;
    }
    return { html, text };
}

async function inlineNode(el, ctx) {
    const empty = { html: '', text: '' };
    const ns = el.namespaceURI;
    const name = el.localName;

    if (ns === NS.w) {
        if (name === 'r') return run(el, ctx);
        if (['hyperlink', 'ins', 'smartTag', 'fldSimple', 'customXml', 'bdo', 'dir'].includes(name)) return inline(el, ctx);
        if (name === 'sdt') return inline(child(el, 'sdtContent') || el, ctx);
        return empty;
    }
    if (ns === NS.m && (name === 'oMath' || name === 'oMathPara')) {
        // Linear text: the maths reads, though fractions and roots flatten.
        const t = [...el.getElementsByTagNameNS(NS.m, 't')].map((n) => n.textContent).join('');
        return { html: `<i>${escapeHtml(t)}</i>`, text: t };
    }
    if (ns === NS.mc && name === 'AlternateContent') {
        const choice = [...el.children].find((c) => c.localName === 'Choice') || [...el.children].find((c) => c.localName === 'Fallback');
        return choice ? inline(choice, ctx) : empty;
    }
    return empty;
}

async function run(r, ctx) {
    const rPr = child(r, 'rPr');
    const bold = on(child(rPr, 'b'));
    const italic = on(child(rPr, 'i'));
    const u = child(rPr, 'u');
    const underline = Boolean(u) && val(u) !== 'none';
    const script = { superscript: 'sup', subscript: 'sub' }[val(child(rPr, 'vertAlign'))];

    let html = '';
    let text = '';
    for (const el of r.children) {
        if (el.namespaceURI === NS.w) {
            if (el.localName === 't') {
                html += escapeHtml(el.textContent);
                text += el.textContent;
            } else if (el.localName === 'tab') {
                html += EM_SPACE;
                text += '\t';
            } else if (el.localName === 'br' || el.localName === 'cr') {
                if (el.getAttributeNS(NS.w, 'type') !== 'page') { html += '<br>'; text += '\n'; }
            } else if (el.localName === 'sym') {
                const code = parseInt(el.getAttributeNS(NS.w, 'char') || '', 16) & 0xFF;
                const ch = SYMBOL[code] || '';
                html += escapeHtml(ch);
                text += ch;
            } else if (el.localName === 'drawing' || el.localName === 'object' || el.localName === 'pict') {
                const pic = await picture(el, ctx);
                html += pic.html;
                text += pic.text;
            }
        } else if (el.namespaceURI === NS.mc && el.localName === 'AlternateContent') {
            const part = await inlineNode(el, ctx);
            html += part.html;
            text += part.text;
        }
    }
    if (!html) return { html: '', text: '' };

    if (script) html = `<${script}>${html}</${script}>`;
    if (underline) html = `<u>${html}</u>`;
    if (italic) html = `<i>${html}</i>`;
    if (bold) html = `<b>${html}</b>`;
    return { html, text };
}

/**
 * A DrawingML blip or a VML imagedata (an OLE object's preview, which for
 * MathType is a WMF). Text boxes inside are queued to follow the paragraph.
 * @returns {Promise<{html: string, text: string}>}
 */
async function picture(el, ctx) {
    for (const box of el.getElementsByTagNameNS(NS.w, 'txbxContent')) ctx.after.push(box);
    const skipped = { html: SKIPPED_MARK, text: '' };

    if (el.localName === 'object') {
        const kept = await oleObject(el, ctx);
        if (kept !== null) return kept;
    }

    const blip = el.getElementsByTagNameNS(NS.a, 'blip')[0];
    const imagedata = el.getElementsByTagNameNS(NS.v, 'imagedata')[0];
    const relId = blip?.getAttributeNS(NS.r, 'embed') || imagedata?.getAttributeNS(NS.r, 'id');
    if (!relId) return { html: '', text: '' };

    const target = ctx.rels.get(relId);
    const ext = target?.split('.').pop().toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!target || !mime) {
        ctx.skipped++;
        return skipped;
    }

    const data = await ctx.zip.read(target);
    if (!data || ctx.imageBytes + data.length > FILE_LIMITS.RENDER_BUDGET_BYTES) {
        ctx.skipped++;
        return skipped;
    }
    ctx.imageBytes += data.length;

    const width = displayWidth(el);
    return { html: `<img src="data:${mime};base64,${toBase64(data)}"${width ? ` width="${width}"` : ''} alt="">`, text: '' };
}

/**
 * An embedded OLE object for the .docx export: a MathType equation as
 * Office Math, anything else kept whole. Its HTML stand-in is the
 * equation's linear text, else the preview when a browser can draw it,
 * else the skipped mark.
 * @returns {Promise<{html: string, text: string}|null>} null when this is
 *   not a keepable object.
 */
async function oleObject(el, ctx) {
    const ole = el.getElementsByTagNameNS(NS.o, 'OLEObject')[0];
    const imagedata = el.getElementsByTagNameNS(NS.v, 'imagedata')[0];
    if (!ole || ole.getAttribute('Type') !== 'Embed') return null;

    const progId = ole.getAttribute('ProgID') || '';
    const binPath = ctx.rels.get(ole.getAttributeNS(NS.r, 'id'));
    const previewPath = imagedata ? ctx.rels.get(imagedata.getAttributeNS(NS.r, 'id')) : null;
    const bin = binPath ? await ctx.zip.read(binPath) : null;
    if (!bin) return null;

    const math = /^Equation\.DSMT/.test(progId) ? mathOf(bin) : null;
    if (math) {
        const index = ctx.ole.length;
        ctx.ole.push({ progId, omml: math.omml, linear: math.linear });
        ctx.converted.push({ el, omml: math.omml });
        return { html: `<span data-ole="${index}">${escapeHtml(math.linear)}</span>`, text: math.linear };
    }

    const preview = previewPath ? await ctx.zip.read(previewPath) : null;

    const size = bin.length + (preview?.length || 0);
    if (ctx.imageBytes + size > FILE_LIMITS.RENDER_BUDGET_BYTES) return null;
    ctx.imageBytes += size;

    // The first object carries the shared picture shapetype; the export
    // writes its own once, so none travels with an object.
    const clone = el.cloneNode(true);
    for (const st of [...clone.getElementsByTagNameNS(NS.v, 'shapetype')]) st.remove();
    for (const shape of clone.getElementsByTagNameNS(NS.v, 'shape')) shape.setAttribute('type', '#_x0000_t75');
    clone.getElementsByTagNameNS(NS.o, 'OLEObject')[0].setAttributeNS(NS.r, 'r:id', OLE_PLACEHOLDERS.BIN_RID);
    clone.getElementsByTagNameNS(NS.v, 'imagedata')[0]?.setAttributeNS(NS.r, 'r:id', OLE_PLACEHOLDERS.PREVIEW_RID);

    const previewExt = previewPath ? previewPath.split('.').pop().toLowerCase() : null;
    const index = ctx.ole.length;
    ctx.ole.push({
        xml: new XMLSerializer().serializeToString(clone),
        progId,
        bin: toBase64(bin),
        preview: preview ? toBase64(preview) : null,
        previewExt,
    });

    const mime = IMAGE_MIME[previewExt];
    if (preview && mime) {
        const width = displayWidth(el);
        return { html: `<img data-ole="${index}" src="data:${mime};base64,${toBase64(preview)}"${width ? ` width="${width}"` : ''} alt="">`, text: '' };
    }
    return { html: `<span data-ole="${index}">${SKIPPED_MARK}</span>`, text: '' };
}

/**
 * A MathType object's equation as Office Math and linear text, or null when
 * any part of it is not understood, so the object is kept instead.
 * @param {Uint8Array} bin  The object's OLE compound file.
 */
function mathOf(bin) {
    try {
        const stream = readCfbStream(bin, 'Equation Native');
        if (!stream) return null;
        const eq = parseEquationNative(stream);
        return { omml: toOmml(eq), linear: toLinear(eq) };
    } catch (err) {
        console.warn('[offscreen] MathType equation kept as an object:', err.message);
        return null;
    }
}

function displayWidth(el) {
    const extent = el.getElementsByTagNameNS(NS.wp, 'extent')[0];
    const cx = Number(extent?.getAttribute('cx'));
    if (cx > 0) return Math.min(MAX_IMAGE_WIDTH, Math.round(cx / EMU_PER_PX));
    const style = el.getElementsByTagNameNS(NS.v, 'shape')[0]?.getAttribute('style') || '';
    const pt = style.match(/width:\s*([\d.]+)pt/)?.[1];
    return pt ? Math.min(MAX_IMAGE_WIDTH, Math.round(Number(pt) * 96 / 72)) : null;
}

// ─── Rewritten package ──────────────────────────────────────────────────────

/**
 * The source package with each converted MathType object swapped for its
 * Office Math, in place, so everything else stays exactly as the author
 * made it. The objects' .bin and preview parts go when nothing else uses them.
 * @param {MiniUnzip} zip
 * @param {Document} doc  word/document.xml, as parsed.
 * @param {Array<{el: Element, omml: string}>} converted
 * @returns {Promise<Uint8Array>}
 */
async function convertedPackage(zip, doc, converted) {
    const root = doc.documentElement;
    if (!root.lookupNamespaceURI('m')) root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:m', NS.m);

    const dropped = new Set();
    const holders = [];
    for (const { el, omml } of converted) {
        const r = el.parentNode;
        if (r?.namespaceURI !== NS.w || r.localName !== 'r' || r.parentNode?.namespaceURI !== NS.w) continue;
        const rPr = child(r, 'rPr');
        const math = mathNode(doc, omml, rPr);
        if (!math) continue;
        for (const n of el.getElementsByTagNameNS(NS.o, 'OLEObject')) dropped.add(n.getAttributeNS(NS.r, 'id'));
        for (const n of el.getElementsByTagNameNS(NS.v, 'imagedata')) dropped.add(n.getAttributeNS(NS.r, 'id'));

        // Shapes later in the file name the shapetype Word stored in this
        // object; an empty picture keeps it.
        const shapetypes = [...el.getElementsByTagNameNS(NS.v, 'shapetype')];
        if (shapetypes.length > 0) {
            const holder = doc.createElementNS(NS.w, 'w:r');
            const pict = holder.appendChild(doc.createElementNS(NS.w, 'w:pict'));
            for (const st of shapetypes) pict.appendChild(st);
            r.parentNode.insertBefore(holder, r);
            holders.push(holder);
        }

        // Anything sharing the run (rare) stays, split around the maths.
        const after = [...r.childNodes].slice([...r.childNodes].indexOf(el) + 1);
        if (after.some((n) => n.nodeType === 1)) {
            const tail = doc.createElementNS(NS.w, 'w:r');
            if (rPr) tail.appendChild(rPr.cloneNode(true));
            for (const n of after) tail.appendChild(n);
            r.parentNode.insertBefore(tail, r.nextSibling);
        }
        r.parentNode.insertBefore(math, r.nextSibling);
        el.remove();
        if (![...r.children].some((c) => c !== rPr)) r.remove();
    }

    const used = new Set([...doc.getElementsByTagNameNS(NS.v, 'shape')].map((s) => s.getAttribute('type')));
    for (const holder of holders) {
        const ids = [...holder.getElementsByTagNameNS(NS.v, 'shapetype')].map((st) => `#${st.getAttribute('id')}`);
        if (!ids.some((id) => used.has(id))) holder.remove();
    }

    const xml = serialise(doc);
    const relsPath = 'word/_rels/document.xml.rels';
    const relsText = await zip.readText(relsPath);
    const removed = new Set();
    let rels = relsText;
    for (const id of dropped) {
        if (!id || xml.includes(`"${id}"`)) continue;
        rels = rels.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*/>`), (tag) => {
            const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
            if (target && !/TargetMode="External"/.test(tag)) {
                removed.add(target.startsWith('/') ? target.slice(1) : normalise(`word/${target}`));
            }
            return '';
        });
    }
    // A part another relationship still names is kept.
    for (const name of zip.names().filter((n) => n.endsWith('.rels') && n !== relsPath)) {
        const text = await zip.readText(name);
        for (const part of [...removed]) if (text.includes(part.split('/').pop())) removed.delete(part);
    }
    for (const part of [...removed]) if (rels.includes(`/${part.split('/').pop()}"`)) removed.delete(part);

    const out = new MiniZip();
    for (const name of zip.names()) {
        if (removed.has(name)) continue;
        if (name === 'word/document.xml') out.addFile(name, xml);
        else if (name === relsPath) out.addFile(name, rels);
        else if (name === '[Content_Types].xml') {
            const types = await zip.readText(name);
            out.addFile(name, types.replace(/<Override\b[^>]*PartName="\/([^"]+)"[^>]*\/>/g, (tag, part) => (removed.has(part) ? '' : tag)));
        } else if (!name.endsWith('/')) out.addFile(name, await zip.read(name));
    }
    return new Uint8Array(await out.toBlob().arrayBuffer());
}

/**
 * One `<m:oMath>`, its runs sized and coloured as the object's run was, in
 * the font Word itself gives Office Math.
 * @param {Document} doc
 * @param {string} omml
 * @param {Element|null} rPr  The object's run properties.
 * @returns {Element|null} null when the OMML does not parse.
 */
function mathNode(doc, omml, rPr) {
    const parsed = new DOMParser().parseFromString(`<w xmlns:m="${NS.m}" xmlns:w="${NS.w}">${omml}</w>`, 'application/xml');
    const first = parsed.documentElement.firstElementChild;
    if (parsed.getElementsByTagName('parsererror').length > 0 || first?.localName !== 'oMath') return null;
    const math = doc.importNode(first, true);

    const props = doc.createElementNS(NS.w, 'w:rPr');
    const fonts = props.appendChild(doc.createElementNS(NS.w, 'w:rFonts'));
    fonts.setAttributeNS(NS.w, 'w:ascii', 'Cambria Math');
    fonts.setAttributeNS(NS.w, 'w:hAnsi', 'Cambria Math');
    for (const name of ['color', 'sz', 'szCs']) {
        const p = child(rPr, name);
        if (p) props.appendChild(p.cloneNode(true));
    }
    for (const mr of math.getElementsByTagNameNS(NS.m, 'r')) {
        const t = [...mr.children].find((c) => c.namespaceURI === NS.m && c.localName === 't');
        mr.insertBefore(props.cloneNode(true), t || null);
    }
    return math;
}

function serialise(doc) {
    const xml = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, '');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${xml}`;
}

// ─── Numbering ──────────────────────────────────────────────────────────────

/** numId → { ilvl → {fmt, text, start} } through the abstract definitions. */
function numberingModel(doc) {
    const model = new Map();
    if (!doc) return model;

    const abstract = new Map();
    for (const an of doc.getElementsByTagNameNS(NS.w, 'abstractNum')) {
        const levels = new Map();
        for (const lvl of children(an, 'lvl')) {
            levels.set(Number(lvl.getAttributeNS(NS.w, 'ilvl')), {
                fmt: val(child(lvl, 'numFmt')) || 'decimal',
                text: val(child(lvl, 'lvlText')) ?? '',
                start: Number(val(child(lvl, 'start'))) || 1,
            });
        }
        abstract.set(an.getAttributeNS(NS.w, 'abstractNumId'), levels);
    }
    for (const num of doc.getElementsByTagNameNS(NS.w, 'num')) {
        const levels = abstract.get(val(child(num, 'abstractNumId')));
        if (levels) model.set(num.getAttributeNS(NS.w, 'numId'), levels);
    }
    return model;
}

function numberPrefix(numPr, ctx) {
    if (!numPr) return '';
    const numId = val(child(numPr, 'numId'));
    const ilvl = Number(val(child(numPr, 'ilvl'))) || 0;
    const levels = ctx.numbering.get(numId);
    const level = levels?.get(ilvl);
    if (!level) return '';
    if (level.fmt === 'bullet') return '•';
    if (level.fmt === 'none') return '';

    const counts = ctx.counters.get(numId) || [];
    counts[ilvl] = counts[ilvl] === undefined ? level.start : counts[ilvl] + 1;
    counts.length = ilvl + 1;
    ctx.counters.set(numId, counts);

    return level.text.replace(/%(\d)/g, (_, d) => {
        const i = Number(d) - 1;
        const lvl = levels.get(i);
        return formatNumber(counts[i] ?? lvl?.start ?? 1, lvl?.fmt || 'decimal');
    });
}

function formatNumber(n, fmt) {
    if (fmt === 'upperLetter') return letters(n).toUpperCase();
    if (fmt === 'lowerLetter') return letters(n);
    if (fmt === 'upperRoman') return roman(n);
    if (fmt === 'lowerRoman') return roman(n).toLowerCase();
    return String(n);
}

function letters(n) {
    return String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
}

function roman(n) {
    const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [value, sym] of table) while (n >= value) { out += sym; n -= value; }
    return out;
}

// ─── Styles and relationships ───────────────────────────────────────────────

/** styleId → heading level, from "heading N" names or an outline level. */
function headingStyles(doc) {
    const map = new Map();
    if (!doc) return map;
    for (const style of doc.getElementsByTagNameNS(NS.w, 'style')) {
        if (style.getAttributeNS(NS.w, 'type') !== 'paragraph') continue;
        const id = style.getAttributeNS(NS.w, 'styleId');
        const name = val(child(style, 'name')) || '';
        const level = Number(name.match(/^heading\s*(\d)$/i)?.[1]) ||
            (/^title$/i.test(name) ? 1 : 0) ||
            outlineLevel(child(style, 'pPr'));
        if (level) map.set(id, level);
    }
    return map;
}

function outlineLevel(pPr) {
    const lvl = val(child(pPr, 'outlineLvl'));
    // 9 is "body text"; only 0-5 are headings.
    return lvl !== null && Number(lvl) < 6 ? Number(lvl) + 1 : 0;
}

/** rId → zip path, resolved against word/. */
function relationships(doc) {
    const map = new Map();
    if (!doc) return map;
    for (const rel of doc.getElementsByTagName('Relationship')) {
        if (rel.getAttribute('TargetMode') === 'External') continue;
        const target = rel.getAttribute('Target') || '';
        const path = target.startsWith('/') ? target.slice(1) : normalise(`word/${target}`);
        map.set(rel.getAttribute('Id'), path);
    }
    return map;
}

function normalise(path) {
    const out = [];
    for (const part of path.split('/')) {
        if (part === '..') out.pop();
        else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
}

function usesLegacyFont(doc) {
    if (!doc) return false;
    for (const f of doc.getElementsByTagNameNS(NS.w, 'rFonts')) {
        for (const attr of ['ascii', 'hAnsi', 'cs']) {
            if (isLegacyVnFont(f.getAttributeNS(NS.w, attr))) return true;
        }
    }
    return false;
}

// ─── XML helpers ────────────────────────────────────────────────────────────

function child(el, name) {
    if (!el) return null;
    for (const c of el.children) if (c.namespaceURI === NS.w && c.localName === name) return c;
    return null;
}

function children(el, name) {
    return [...el.children].filter((c) => c.namespaceURI === NS.w && c.localName === name);
}

function val(el) {
    return el ? el.getAttributeNS(NS.w, 'val') : null;
}

/** `<w:b/>` is on; `<w:b w:val="0"/>` and `false` are off. */
function on(el) {
    if (!el) return false;
    const v = val(el);
    return v === null || v === '' || !/^(0|false|off|none)$/i.test(v);
}

function toBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
