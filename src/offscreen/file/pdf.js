/**
 * PDF bytes to body HTML through pdf.js. This reads each page's geometry
 * (glyph runs, rules, shapes, pictures, the page size) and lib/pdf-layout.js
 * rebuilds the page from it: tables from their rules, equations from their
 * glyphs and bars, sections per page size. What it cannot rebuild as text
 * (figures, scans) is rendered here and kept as JPEG.
 */
import * as pdfjs from '../../vendor/pdfjs/pdf.min.mjs';
import { layoutPages, planPage } from '../../lib/pdf-layout.js';
import { isLegacyVnFont } from '../../lib/vnfont.js';
import { FILE_LIMITS, WARNINGS, WARNING_PREFIXES } from '../../lib/const.js';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;

/** About 144 dpi: maths stays legible without page images running to MBs. */
const RENDER_SCALE = 2;
const JPEG_QUALITY = 0.8;

/** A page with less text than this is a picture of a page. */
const MIN_PAGE_TEXT = 20;

/** One page's render; past this its pictures are dropped, with a warning. */
const RENDER_TIMEOUT_MS = 15_000;

/** Marked-content tags that group one equation or one figure. */
const GROUP_TAGS = new Set(['InlineShape', 'Formula', 'Figure']);

const IMAGE_OPS = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
]);

const { OPS } = pdfjs;
const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const STROKE_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

/** pdf.js path opcodes inside constructPath. */
const PATH = { MOVE: 0, LINE: 1, CURVE: 2, QUAD: 3, CLOSE: 4 };

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{title: string, text: string, bodyHtml: string, warnings: string[], ole: object[]}>}
 */
export async function parsePdf(bytes) {
    const doc = await pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false,
        useSystemFonts: true,
        wasmUrl: new URL('wasm/', VENDOR).href,
        // Broken font hinting and the like are logged per glyph; only errors matter here.
        verbosity: pdfjs.VerbosityLevel.ERRORS,
    }).promise;

    const pages = [];
    const render = { pages: 0, bytes: 0, exhausted: false };
    let pagesAsImages = 0;
    let legacyFont = false;

    try {
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const geometry = await readPage(page);
            if (geometry.items.some((it) => isLegacyVnFont(it.fontName))) legacyFont = true;

            const chars = geometry.items.reduce((sum, it) => sum + it.str.trim().length, 0);
            const scanned = chars < MIN_PAGE_TEXT;
            if (scanned) {
                geometry.items = [];
                geometry.shapes = [];
                geometry.pictures = [];
            }

            // The whole page for a scan, else the regions layout keeps as pictures.
            const regions = scanned
                ? [{ x0: 0, y0: 0, x1: geometry.width, y1: geometry.height }]
                : planPage(geometry).crops;
            const crops = regions.length > 0 ? await renderRegions(page, regions, render) : [];
            if (scanned && crops.some(Boolean)) pagesAsImages++;

            pages.push({ ...geometry, scanned, crops });
            page.cleanup();
        }

        const { bodyHtml, text, ole } = layoutPages(pages);
        const meta = await doc.getMetadata().catch(() => null);

        const warnings = [];
        if (pagesAsImages > 0) warnings.push(`${WARNING_PREFIXES.PDF_PAGES_AS_IMAGES}:${pagesAsImages}`);
        if (render.exhausted) warnings.push(WARNINGS.PDF_RENDER_BUDGET_EXCEEDED);
        if (legacyFont) warnings.push(WARNINGS.LEGACY_VN_FONT);

        return { title: (meta?.info?.Title || '').trim(), text, bodyHtml, warnings, ole };
    } finally {
        await doc.destroy();
    }
}

/**
 * One page as lib/pdf-layout's PageGeometry, in top-down page points.
 * Exported for tools/harness, which dumps it to build layout fixtures.
 * @param {object} page  A pdf.js PDFPageProxy.
 */
export async function readPage(page) {
    const viewport = page.getViewport({ scale: 1 });
    // The operator list first: it resolves the fonts into commonObjs.
    const ops = await page.getOperatorList();
    const content = await page.getTextContent({ includeMarkedContent: true });

    const items = [];
    const groups = [];
    for (const raw of content.items) {
        if (raw.type === 'beginMarkedContentProps' || raw.type === 'beginMarkedContent') {
            const mcid = /_mc(\d+)$/.exec(raw.id || '')?.[1];
            groups.push(GROUP_TAGS.has(raw.tag) && mcid !== undefined ? `${raw.tag}:${mcid}` : null);
            continue;
        }
        if (raw.type === 'endMarkedContent') {
            groups.pop();
            continue;
        }
        if (typeof raw.str !== 'string' || raw.str === '') continue;
        const item = toItem(raw, viewport, page);
        const group = groups.findLast(Boolean);
        if (group) item.group = group;
        items.push(item);
    }

    const { shapes, pictures } = readDrawing(ops, viewport);
    return { width: viewport.width, height: viewport.height, items, shapes, pictures };
}

/** pdf.js item to lib/pdf-layout's TextItem. */
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
 * Replays the operator list's transforms to place every path and picture
 * on the page. Clipping paths draw nothing and are skipped.
 * @returns {{shapes: object[], pictures: object[]}}
 */
function readDrawing(ops, viewport) {
    const { Util } = pdfjs;
    const shapes = [];
    const pictures = [];
    const stack = [];
    const marks = [];
    let state = { ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', lineWidth: 1 };

    const point = (x, y) => {
        const { ctm } = state;
        return viewport.convertToViewportPoint(x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]);
    };

    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];

        if (fn === OPS.save) stack.push({ ...state });
        else if (fn === OPS.restore) state = stack.pop() || state;
        else if (fn === OPS.transform) state.ctm = Util.transform(state.ctm, args);
        else if (fn === OPS.paintFormXObjectBegin) {
            stack.push({ ...state });
            if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) state.ctm = Util.transform(state.ctm, args[0]);
        } else if (fn === OPS.paintFormXObjectEnd) state = stack.pop() || state;
        else if (fn === OPS.setLineWidth) state.lineWidth = args[0];
        else if (fn === OPS.setFillRGBColor) state.fill = colorOf(args);
        else if (fn === OPS.beginMarkedContentProps || fn === OPS.beginMarkedContent) {
            const mcid = typeof args?.[1] === 'number' ? args[1] : args?.[1]?.MCID;
            marks.push(GROUP_TAGS.has(args?.[0]) && mcid !== undefined ? `${args[0]}:${mcid}` : null);
        } else if (fn === OPS.endMarkedContent) marks.pop();
        else if (fn === OPS.constructPath) {
            const [paint, paths] = args;
            const fill = FILL_OPS.has(paint);
            const stroke = STROKE_OPS.has(paint);
            if (!fill && !stroke) continue;
            const scale = Math.sqrt(Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2]));
            const group = marks.findLast(Boolean);
            for (const data of paths || []) {
                for (const sub of subpaths(data, point)) {
                    shapes.push({
                        ...sub,
                        fill: fill ? state.fill : null,
                        stroke,
                        lineWidth: state.lineWidth * scale,
                        ...(group ? { group } : {}),
                    });
                }
            }
        } else if (IMAGE_OPS.has(fn)) {
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => point(u, v));
            const xs = corners.map((p) => p[0]);
            const ys = corners.map((p) => p[1]);
            const group = marks.findLast(Boolean);
            pictures.push({
                x0: Math.max(0, Math.min(...xs)),
                y0: Math.max(0, Math.min(...ys)),
                x1: Math.min(viewport.width, Math.max(...xs)),
                y1: Math.min(viewport.height, Math.max(...ys)),
                ...(group ? { group } : {}),
            });
        }
    }
    return { shapes, pictures };
}

/** A fill colour as #rrggbb, from the hex string or the components pdf.js passes. */
function colorOf(args) {
    if (typeof args?.[0] === 'string') return args[0].toLowerCase();
    const [r, g, b] = Array.from(args || [], (c) => Math.max(0, Math.min(255, Math.round(c))));
    return `#${[r, g, b].map((c) => (c || 0).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A constructPath operand as subpaths in page points: `points` are the
 * corners, `curved` whether a Bézier was among them, `closed` whether it shut.
 */
function subpaths(data, point) {
    const out = [];
    let current = null;
    const begin = (p) => {
        current = { points: [p], curved: false, closed: false };
        out.push(current);
    };
    for (let i = 0; i < data.length;) {
        const op = data[i++];
        if (op === PATH.MOVE) begin(point(data[i++], data[i++]));
        else if (op === PATH.LINE) {
            const p = point(data[i++], data[i++]);
            if (current) current.points.push(p);
            else begin(p);
        } else if (op === PATH.CURVE || op === PATH.QUAD) {
            const n = op === PATH.CURVE ? 6 : 4;
            const p = point(data[i + n - 2], data[i + n - 1]);
            i += n;
            if (!current) begin(p);
            current.points.push(p);
            current.curved = true;
        } else if (op === PATH.CLOSE) {
            if (current) current.closed = true;
        } else break;
    }
    return out.map((s) => {
        const xs = s.points.map((p) => p[0]);
        const ys = s.points.map((p) => p[1]);
        return {
            x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
            points: s.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
            curved: s.curved,
            closed: s.closed,
        };
    });
}

/**
 * Render the page once and crop each region from it.
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} regions  Page points.
 * @returns {Promise<Array<{src: string}|null>>}  One per region, null where the budget ran out.
 */
async function renderRegions(page, regions, render) {
    if (render.pages >= FILE_LIMITS.MAX_RENDERED_PAGES || render.bytes >= FILE_LIMITS.RENDER_BUDGET_BYTES) {
        render.exhausted = true;
        return regions.map(() => null);
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
            return regions.map(() => null);
        }

        return regions.map((region) => {
            if (render.exhausted) return null;
            const src = crop(canvas, region);
            const size = Math.ceil(src.length * 0.75);
            if (render.bytes + size > FILE_LIMITS.RENDER_BUDGET_BYTES) {
                render.exhausted = true;
                return null;
            }
            render.bytes += size;
            return { src };
        });
    } finally {
        clearTimeout(timer);
        canvas.width = 0;
        canvas.height = 0;
    }
}

function crop(canvas, { x0, y0, x1, y1 }) {
    const sx = Math.max(0, Math.floor(x0 * RENDER_SCALE));
    const sy = Math.max(0, Math.floor(y0 * RENDER_SCALE));
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil((x1 - x0) * RENDER_SCALE)));
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil((y1 - y0) * RENDER_SCALE)));
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
