/**
 * PDF bytes to body HTML through pdf.js. Text comes from the text layer;
 * a page without one (a scan) and the pictures on a page are rendered and
 * kept as JPEG, so nothing disappears without a warning.
 */
import * as pdfjs from '../../vendor/pdfjs/pdf.min.mjs';
import { layoutPages } from '../../lib/pdf-layout.js';
import { isLegacyVnFont } from '../../lib/vnfont.js';
import { FILE_LIMITS, WARNINGS, WARNING_PREFIXES } from '../../lib/const.js';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;

/** About 144 dpi: maths stays legible without page images running to MBs. */
const RENDER_SCALE = 2;
const JPEG_QUALITY = 0.8;

/** A page with less text than this is a picture of a page. */
const MIN_PAGE_TEXT = 20;

/** Smaller pictures are rules, bullets and glyph art, in points. */
const MIN_IMAGE_PT = 24;

/** A picture covering this much of a page with text is its background. */
const BACKGROUND_COVERAGE = 0.85;

/** Displayed width of a full-page picture, in CSS pixels. */
const PAGE_IMAGE_WIDTH = 640;

/** One page's render; past this its pictures are dropped, with a warning. */
const RENDER_TIMEOUT_MS = 15_000;

const IMAGE_OPS = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
]);

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{title: string, text: string, bodyHtml: string, warnings: string[]}>}
 */
export async function parsePdf(bytes) {
    const doc = await pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false,
        useSystemFonts: true,
        wasmUrl: new URL('wasm/', VENDOR).href,
    }).promise;

    const pages = [];
    const render = { pages: 0, bytes: 0, exhausted: false };
    let pagesAsImages = 0;
    let legacyFont = false;

    try {
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const viewport = page.getViewport({ scale: 1 });

            // Resolves the page's fonts into commonObjs (for bold/italic)
            // and lists where its pictures are drawn.
            const ops = await page.getOperatorList();
            const content = await page.getTextContent();

            const items = [];
            for (const raw of content.items) {
                if (typeof raw.str !== 'string') continue;
                const item = toItem(raw, viewport, page);
                if (isLegacyVnFont(item.fontName)) legacyFont = true;
                items.push(item);
            }

            const chars = items.reduce((sum, it) => sum + it.str.trim().length, 0);
            const scanned = chars < MIN_PAGE_TEXT;
            const boxes = scanned ? [] : imageBoxes(ops, viewport);

            let images = [];
            if (scanned || boxes.length > 0) {
                images = await pictures(page, scanned ? null : boxes, render);
                if (scanned && images.length > 0) pagesAsImages++;
            }

            pages.push({ items: scanned ? [] : items, images });
            page.cleanup();
        }

        const { bodyHtml, text } = layoutPages(pages);
        const meta = await doc.getMetadata().catch(() => null);

        const warnings = [];
        if (pagesAsImages > 0) warnings.push(`${WARNING_PREFIXES.PDF_PAGES_AS_IMAGES}:${pagesAsImages}`);
        if (render.exhausted) warnings.push(WARNINGS.PDF_RENDER_BUDGET_EXCEEDED);
        if (legacyFont) warnings.push(WARNINGS.LEGACY_VN_FONT);

        return { title: (meta?.info?.Title || '').trim(), text, bodyHtml, warnings };
    } finally {
        await doc.destroy();
    }
}

/** pdf.js item to lib/pdf-layout's TextItem, in top-down page points. */
function toItem(raw, viewport, page) {
    const [a, b, c, d, e, f] = raw.transform;
    const [x, y] = viewport.convertToViewportPoint(e, f);
    const font = fontOf(page, raw.fontName);
    const name = font?.name || '';
    return {
        str: raw.str,
        x,
        y,
        w: raw.width,
        h: Math.hypot(c, d) || Math.hypot(a, b),
        bold: Boolean(font?.bold) || /bold|black|heavy|semibold/i.test(name),
        italic: Boolean(font?.italic) || /italic|oblique/i.test(name),
        fontName: name,
    };
}

function fontOf(page, id) {
    try {
        return page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
    } catch {
        return null;
    }
}

/**
 * Where each picture lands, by replaying the transforms in the operator
 * list: an image is drawn into the unit square of the current matrix.
 * @returns {Array<{left: number, top: number, width: number, height: number}>}
 */
function imageBoxes(ops, viewport) {
    const { OPS, Util } = pdfjs;
    const boxes = [];
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];

    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];

        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() || ctm;
        else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
        else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm);
            if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = Util.transform(ctm, args[0]);
        } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
        else if (IMAGE_OPS.has(fn)) {
            // By hand: Util.applyTransform changed to in-place across versions.
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
                viewport.convertToViewportPoint(u * ctm[0] + v * ctm[2] + ctm[4], u * ctm[1] + v * ctm[3] + ctm[5]));
            const xs = corners.map((p) => p[0]);
            const ys = corners.map((p) => p[1]);
            const box = {
                left: Math.max(0, Math.min(...xs)),
                top: Math.max(0, Math.min(...ys)),
                width: Math.min(viewport.width, Math.max(...xs)) - Math.max(0, Math.min(...xs)),
                height: Math.min(viewport.height, Math.max(...ys)) - Math.max(0, Math.min(...ys)),
            };
            const coverage = (box.width * box.height) / (viewport.width * viewport.height);
            if (box.width >= MIN_IMAGE_PT && box.height >= MIN_IMAGE_PT && coverage < BACKGROUND_COVERAGE) {
                boxes.push(box);
            }
        }
    }
    return boxes;
}

/**
 * Render the page once, then keep it whole (`boxes` null) or crop each box.
 * @returns {Promise<Array<{y: number, html: string}>>}
 */
async function pictures(page, boxes, render) {
    if (render.pages >= FILE_LIMITS.MAX_RENDERED_PAGES || render.bytes >= FILE_LIMITS.RENDER_BUDGET_BYTES) {
        render.exhausted = true;
        return [];
    }
    render.pages++;

    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    // The 'display' intent paces itself on requestAnimationFrame, which never
    // fires in a hidden offscreen document; 'print' schedules on microtasks.
    const task = page.render({ canvas, viewport, intent: 'print' });
    let timer;
    try {
        const rendered = await Promise.race([
            task.promise.then(() => true, () => false),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), RENDER_TIMEOUT_MS); }),
        ]);
        if (!rendered) {
            task.cancel();
            console.warn(`[offscreen] page render timed out after ${RENDER_TIMEOUT_MS}ms; its pictures are dropped.`);
            render.exhausted = true;
            return [];
        }

        const regions = boxes
            ? boxes.map((b) => ({ ...b, display: Math.round(b.width * 96 / 72) }))
            : [{ left: 0, top: 0, width: viewport.width / RENDER_SCALE, height: viewport.height / RENDER_SCALE, display: PAGE_IMAGE_WIDTH }];

        const out = [];
        for (const region of regions) {
            const dataUrl = crop(canvas, region);
            const size = Math.ceil(dataUrl.length * 0.75);
            if (render.bytes + size > FILE_LIMITS.RENDER_BUDGET_BYTES) {
                render.exhausted = true;
                break;
            }
            render.bytes += size;
            out.push({
                y: region.top,
                html: `<p style="text-align:center"><img src="${dataUrl}" width="${Math.min(region.display, PAGE_IMAGE_WIDTH)}" alt=""></p>`,
            });
        }
        return out;
    } finally {
        clearTimeout(timer);
        canvas.width = 0;
        canvas.height = 0;
    }
}

function crop(canvas, { left, top, width, height }) {
    const sx = Math.floor(left * RENDER_SCALE);
    const sy = Math.floor(top * RENDER_SCALE);
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(width * RENDER_SCALE)));
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(height * RENDER_SCALE)));
    if (sx === 0 && sy === 0 && sw === canvas.width && sh === canvas.height) {
        return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    }
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const url = out.toDataURL('image/jpeg', JPEG_QUALITY);
    out.width = 0;
    return url;
}
