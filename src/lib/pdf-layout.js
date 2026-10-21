/**
 * PDF page geometry to body HTML that keeps the page's look. A PDF stores
 * positioned glyph runs and paths, not paragraphs or tables, so this
 * rebuilds them: tables from their rules (lib/pdf-table.js), equations from
 * glyphs and bars (lib/pdf-math.js), side-by-side columns from the gaps
 * between them, and every paragraph's indent, alignment and spacing from
 * where its lines sit. Each page becomes a section of its own size and
 * margins. offscreen/file/pdf.js measures; this only does geometry.
 */
import { escapeHtml } from './html.js';
import { isLegacyVnFont } from './vnfont.js';
import { buildEquation, readable, splitWords } from './pdf-math.js';
import { rulesOf, findTables } from './pdf-table.js';

/**
 * Starts a new paragraph even when the line above ran to the margin: exam
 * questions, answer choices and list items in Vietnamese teaching material.
 */
const BLOCK_START = /^(Câu|Bài|Phần|PHẦN|Ví dụ|Lời giải|Hướng dẫn|Đáp án|[A-Da-d][.)]|\d{1,3}[.)]|[IVX]{1,5}[.)]|[-–•+*●▪])\s/;

/** Style suffixes of a PostScript font name: the family is what precedes them. */
const FONT_STYLE = /[-,]?(Bold|Italic|Oblique|Regular|Medium|Light|Semibold|SemiBold|Black|Heavy|Condensed)+(MT)?$/;

/** The PDF base fonts by their Word stand-ins, and names that do not split on capitals. */
const FONT_NAMES = {
    times: 'Times New Roman', helvetica: 'Arial', courier: 'Courier New',
    cambriamath: 'Cambria Math', symbol: 'Symbol', wingdings: 'Wingdings', segoeui: 'Segoe UI',
    simsun: 'SimSun', mingliu: 'MingLiU',
};

/** Word's cell padding left and right (TableNormal in popup/docx.js), in points. */
const CELL_PAD = 5.4;

/** Times New Roman's descent and Word's single line, per point of font size. */
const DESCENT = 0.216;
const SINGLE_LINE = 1.15;

/** A gap wider than this many font sizes splits a line into tab-separated parts. */
const SEGMENT_GAP = 1.8;

/** Smaller pictures and drawings (points) are rules, bullets and specks. */
const MIN_FIGURE_PT = 8;

/**
 * Word writes Cambria Math into PDFs with a broken ToUnicode map: each
 * letter comes out doubled, and often as the wrong letter. Text like that
 * cannot be trusted, so its equation is kept as a picture.
 */
const DOUBLED_MATH = /^(?:([\u{1D400}-\u{1D7FF}])\1)+$/u;

/** Stands in for an inline picture in a line's text; lines drop blank items. */
const OBJECT_MARK = '\uFFFC';

/** A picture covering this much of a page is its background. */
const BACKGROUND_COVERAGE = 0.85;

/** Margins of a page with no text to measure them from (a scan), in points. */
const SCAN_MARGIN = 18;

/** An empty cell's paragraph: one plain line high, not Word's spaced default. */
const EMPTY_CELL = '<p style="margin:0;line-height:1pt"></p>';

const WHITE = '#ffffff';
const PX_PER_PT = 96 / 72;

/**
 * @typedef {{str: string, x: number, y: number, w: number, h: number, bold?: boolean, italic?: boolean,
 *   fontName?: string, group?: string}} TextItem
 *   `y` is the baseline measured from the top of the page; `h` the font size;
 *   `group` the marked-content group (`InlineShape:12`) the run was drawn in.
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Box  Page points, top-down.
 * @typedef {Box & {points?: number[][], curved?: boolean, closed?: boolean, fill?: string|null,
 *   stroke?: boolean, lineWidth?: number, group?: string}} Shape
 * @typedef {{width: number, height: number, items: TextItem[], shapes?: Shape[], pictures?: Array<Box & {group?: string}>,
 *   scanned?: boolean, crops?: Array<{src: string}|null>}} PageGeometry
 *   `crops`: the pictures offscreen/file/pdf.js rendered for planPage()'s regions, in its order.
 */

/**
 * The regions of a page that stay pictures (figures, drawings, equations
 * that could not be rebuilt), for the caller to render and crop.
 * @param {PageGeometry} page
 * @returns {{crops: Box[]}}
 */
export function planPage(page) {
    return { crops: analyse(page, []).figures.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })) };
}

/**
 * @param {PageGeometry[]} pages
 * @returns {{bodyHtml: string, text: string, ole: Array<{progId: string, omml: string, linear: string}>}}
 *   `ole`: the rebuilt equations, which bodyHtml marks with `data-ole`.
 */
export function layoutPages(pages) {
    const ole = [];
    const analysed = (pages || []).map((page) => (page.scanned ? scanPage(page) : analyse(page, ole)));
    const pitches = linePitches(analysed);
    const margins = marginsOf(analysed, pitches);

    const html = [];
    const text = [];
    analysed.forEach((page, i) => {
        const out = renderPage(page, margins[i], { pitches, crops: pages[i].crops || [], marginLeft: margins[i].left });
        html.push(out.html);
        if (out.text) text.push(out.text);
    });
    return { bodyHtml: html.join('\n'), text: text.join('\n\n'), ole };
}

// ─── Analysis ───────────────────────────────────────────────────────────────

/**
 * What a page is made of: equations rebuilt into single text items, tables
 * with the items in each cell, figures, and the lines of text left over.
 * Deterministic, so planPage() and layoutPages() agree on the figures.
 * @param {PageGeometry} page
 * @param {object[]} ole  Collects rebuilt equations.
 */
function analyse(page, ole) {
    const width = page.width || 595;
    const height = page.height || 842;
    const items = (page.items || []).filter((it) => it && typeof it.str === 'string' && it.h > 0);
    const shapes = (page.shapes || []).filter((s) => s.stroke || (s.fill && s.fill !== WHITE));
    const pictures = (page.pictures || []).filter((p) => {
        const area = (p.x1 - p.x0) * (p.y1 - p.y0);
        return area < BACKGROUND_COVERAGE * width * height && p.x1 - p.x0 >= 1 && p.y1 - p.y0 >= 1;
    });

    const consumed = new Set();
    const usedShapes = new Set();
    const flowItems = [];
    const regions = [];
    // Equations kept as pictures inside their line of text.
    const inlineCrops = [];
    const keepInline = (members, box) => {
        const full = members.filter((it) => it.str.trim());
        const size = Math.max(...full.map((it) => it.h));
        const main = full.filter((it) => it.h >= 0.85 * size);
        inlineCrops.push({ ...pad(box, 1), baseline: median(main.map((it) => it.y)), size });
        for (const it of members) consumed.add(it);
    };

    // Marked-content groups: an equation (rebuilt, or left as runs), or a figure.
    const groups = new Map();
    const groupOf = (key) => {
        if (!groups.has(key)) groups.set(key, { items: [], shapes: [], pictures: [] });
        return groups.get(key);
    };
    for (const it of items) if (it.group) groupOf(it.group).items.push(it);
    for (const s of shapes) if (s.group) groupOf(s.group).shapes.push(s);
    for (const p of pictures) if (p.group) groupOf(p.group).pictures.push(p);

    for (const [key, g] of groups) {
        const hasText = g.items.some((it) => it.str.trim());
        if (key.startsWith('Figure') || !hasText || g.pictures.length > 0) {
            if (g.shapes.length === 0 && g.pictures.length === 0) continue;
            regions.push(boxOf([...g.shapes, ...g.pictures]));
            for (const s of g.shapes) usedShapes.add(s);
            continue;
        }
        if (!readable(g.items)) {
            // A symbol only its own font draws: the equation stays as it looks, in its line.
            const box = boxOf([...g.items.filter((it) => it.str.trim()).map(itemBox), ...g.shapes]);
            const size = Math.max(...g.items.map((it) => it.h));
            for (const s of g.shapes) usedShapes.add(s);
            if (box.y1 - box.y0 <= 3.5 * size) keepInline(g.items, box);
            else {
                regions.push(box);
                for (const it of g.items) consumed.add(it);
            }
            continue;
        }
        const eq = buildEquation(g.items, g.shapes);
        for (const s of g.shapes) usedShapes.add(s);
        if (eq) {
            // Word draws a space of the paragraph's font on the line's own baseline beside each equation.
            const anchor = g.items
                .filter((it) => !it.str.trim() && it.h >= eq.size && Math.abs(it.y - eq.baseline) < 0.6 * it.h)
                .sort((a, b) => Math.abs(a.y - eq.baseline) - Math.abs(b.y - eq.baseline))[0];
            if (anchor) eq.baseline = anchor.y;
            flowItems.push(mathItem(eq, ole));
            for (const it of g.items) consumed.add(it);
        } else if (g.shapes.some((s) => s.y1 - s.y0 > 2 && s.x1 - s.x0 > 2)) {
            // Drawn parts this cannot rebuild: the equation stays as it looks, in its line.
            const box = boxOf([...g.items.filter((it) => it.str.trim()).map(itemBox), ...g.shapes]);
            const size = Math.max(...g.items.map((it) => it.h));
            if (box.y1 - box.y0 <= 3.5 * size) keepInline(g.items, box);
            else {
                regions.push(box);
                for (const it of g.items) consumed.add(it);
            }
        }
    }
    // Bars among them are their fractions'.
    const looseBars = shapes.filter((sh) => !sh.group && isRuleShape(sh) && sh.y1 - sh.y0 < 1.6 && sh.x1 - sh.x0 < 160);
    for (const run of unreadableMath(items.filter((it) => !consumed.has(it)), looseBars)) keepInline(run.items, run.box);

    // Ungrouped paths: rules make tables; short bars over and under text are fractions.
    const loose = shapes.filter((s) => !s.group);
    const rules = rulesOf(loose);
    const fills = loose.filter((s) => s.fill && s.x1 - s.x0 > 3 && s.y1 - s.y0 > 3);
    const { tables, used } = findTables(rules, fills);
    for (const eq of untaggedEquations(items.filter((it) => !it.group && !consumed.has(it)), rules.filter((r) => !used.has(r)), loose)) {
        flowItems.push(mathItem(eq.equation, ole));
        for (const it of eq.items) consumed.add(it);
        for (const s of eq.shapes) usedShapes.add(s);
    }

    // What remains drawn, bar rules and shading: figures, with the rules that touch them.
    const free = loose.filter((s) => !usedShapes.has(s));
    const drawings = free.filter((s) => !isRuleShape(s) && !isShading(s));
    const spare = free.filter((s) => isRuleShape(s) && !tables.some((t) => contains(t, centre(s), 2)));
    for (const cluster of clusters(drawings.map(plainBox), 3)) regions.push(withTouching(cluster, spare));
    for (const p of pictures) if (!p.group) regions.push(plainBox(p));

    const figures = clusters(regions.filter((r) => r.x1 - r.x0 >= MIN_FIGURE_PT && r.y1 - r.y0 >= MIN_FIGURE_PT), 1);
    for (const f of figures) {
        for (const it of items) {
            if (consumed.has(it) || !it.str.trim()) continue;
            const b = itemBox(it);
            if (contains(f, centre(b), 1)) {
                consumed.add(it);
                f.x0 = Math.min(f.x0, b.x0); f.y0 = Math.min(f.y0, b.y0);
                f.x1 = Math.max(f.x1, b.x1); f.y1 = Math.max(f.y1, b.y1);
            }
        }
    }
    figures.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    // Inline pictures after the figures: planPage() crops both, in this order.
    for (const c of inlineCrops) {
        figures.push({ ...c, inline: true });
        flowItems.push({
            str: OBJECT_MARK, x: c.x0, w: c.x1 - c.x0, y: c.baseline, h: c.size,
            crop: figures.length - 1, inkTop: c.y0, inkBottom: c.y1,
        });
    }
    figures.forEach((f, i) => { f.index = i; });

    // A drawing no taller than a line, set on a line of text, is a glyph of that line.
    for (const f of figures) {
        if (f.inline || f.y1 - f.y0 > 24) continue;
        const mates = flowItems.filter((it) => it.str.trim() && it.y >= f.y0 && it.y <= f.y1 + 0.4 * it.h &&
            Math.min(Math.abs(it.x - f.x1), Math.abs(f.x0 - (it.x + it.w))) < 3 * it.h);
        if (mates.length === 0) continue;
        const size = Math.max(...mates.map((it) => it.h));
        f.inline = true;
        flowItems.push({
            str: OBJECT_MARK, x: f.x0, w: f.x1 - f.x0, y: median(mates.map((it) => it.y)), h: size,
            crop: f.index, inkTop: f.y0, inkBottom: f.y1,
        });
    }

    // An equation left as runs keeps its glyphs in order: primes sit between letters.
    for (const it of items) if (!consumed.has(it)) flowItems.push(...(it.group ? splitWords(it) : [it]));

    // Into the table cell each item or figure sits in, else the page.
    const cellOf = (b) => {
        const c = centre(b);
        for (const table of tables) {
            if (!contains(table, c)) continue;
            const cell = table.cells.find((k) => contains(k, c));
            if (cell) return cell;
        }
        return null;
    };
    for (const t of tables) for (const c of t.cells) { c.items = []; c.figures = []; }
    const pageItems = [];
    for (const it of flowItems) {
        const cell = cellOf(itemBox(it));
        if (cell) cell.items.push(it);
        else pageItems.push(it);
    }
    const pageFigures = [];
    for (const f of figures.filter((x) => !x.inline)) {
        const cell = cellOf(f);
        if (cell) cell.figures.push(f);
        else pageFigures.push(f);
    }

    return {
        width, height, tables, figures, pageFigures,
        lines: buildLines(pageItems),
        cellLines: new Map(tables.flatMap((t) => t.cells.map((c) => [c, buildLines(c.items)]))),
    };
}

function scanPage(page) {
    const width = page.width || 595;
    const height = page.height || 842;
    const figure = { x0: 0, y0: 0, x1: width, y1: height, index: 0, scan: true };
    return { width, height, tables: [], figures: [figure], pageFigures: [figure], lines: [], cellLines: new Map(), scanned: true };
}

/** A rebuilt equation as one text item on its baseline. */
function mathItem(eq, ole) {
    ole.push({ progId: 'pdf', omml: eq.omml, linear: eq.linear });
    return {
        str: eq.linear, x: eq.x0, y: eq.baseline, w: eq.x1 - eq.x0, h: eq.size,
        math: ole.length - 1, inkTop: eq.y0, inkBottom: eq.y1,
    };
}

/**
 * Fractions in a PDF without equation tags: a short bar with text sitting
 * clear over it and text just under it, and whatever else shares that span.
 */
function untaggedEquations(items, rules, shapes) {
    const out = [];
    const taken = new Set();
    const bars = rules.filter((r) => r.dir === 'h' && r.to - r.from < 160 && r.width <= 1.6);
    for (const bar of bars) {
        const within = (it) => it.x >= bar.from - 1.5 && it.x + it.w <= bar.to + 1.5;
        // A numerator clears the bar; an underlined word sits on it.
        const over = items.filter((it) => !taken.has(it) && within(it) && bar.at - it.y >= 0.25 * it.h && bar.at - it.y < 1.6 * it.h);
        const under = items.filter((it) => !taken.has(it) && within(it) && it.y > bar.at && it.y - 0.75 * it.h < bar.at + 0.6 * it.h);
        if (over.length === 0 || under.length === 0) continue;
        const size = Math.max(...over.map((it) => it.h), ...under.map((it) => it.h));
        const box = { x0: bar.from - 1.5, x1: bar.to + 1.5, y0: bar.at - 1.8 * size, y1: bar.at + 1.8 * size };
        const members = items.filter((it) => !taken.has(it) && contains(box, centre(itemBox(it))));
        const parts = shapes.filter((s) => contains(box, centre(s), 1));
        const equation = buildEquation(members, parts);
        if (!equation) continue;
        for (const it of members) taken.add(it);
        out.push({ equation, items: members, shapes: parts });
    }
    return out;
}

/**
 * Cambria Math whose text reads doubled, with what it is set with (scripts,
 * numerators over denominators, the bars between): glyph boxes that touch,
 * or sit within a size and a half of each other on a line, are one equation.
 * @returns {Array<{items: TextItem[], box: Box}>}
 */
function unreadableMath(items, bars) {
    const math = items.filter((it) => /CambriaMath/i.test(it.fontName || ''));
    if (!math.some((it) => DOUBLED_MATH.test(it.str.trim()))) return [];
    const parts = [
        ...math.map((it) => ({ item: it, box: itemBox(it), size: it.h })),
        ...bars.map((b) => ({ item: null, box: plainBox(b), size: 0 })),
    ];
    const parent = parts.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < parts.length; i++) {
        for (let k = i + 1; k < parts.length; k++) {
            const a = parts[i].box;
            const b = parts[k].box;
            // Wide enough to span a glyph drawn with no text (a similarity sign) between two runs.
            const reach = 1.6 * Math.max(parts[i].size, parts[k].size, 8);
            const dx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
            const dy = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
            if (dx <= reach && dy <= 0.5) parent[find(i)] = find(k);
        }
    }
    const groups = new Map();
    parts.forEach((part, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(part);
    });
    return [...groups.values()]
        .filter((g) => g.some((part) => part.item && DOUBLED_MATH.test(part.item.str.trim())))
        .map((g) => ({ items: g.filter((part) => part.item).map((part) => part.item), box: boxOf(g.map((part) => part.box)) }));
}

function pad(box, by) {
    return { x0: box.x0 - by, y0: box.y0 - by, x1: box.x1 + by, y1: box.y1 + by };
}

function isRuleShape(s) {
    if (s.curved) return false;
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    return Math.min(w, h) <= 2.5 && Math.max(w, h) >= 2;
}

/** A filled axis-aligned rectangle: a cell's or a box's background, not a drawing. */
function isShading(s) {
    return Boolean(s.fill) && !s.curved && (!s.points || s.points.length <= 5) &&
        (s.points || []).every(([x, y]) => (Math.abs(x - s.x0) < 0.3 || Math.abs(x - s.x1) < 0.3) && (Math.abs(y - s.y0) < 0.3 || Math.abs(y - s.y1) < 0.3));
}

/** A drawing's box grown over the loose rules that touch it: a figure's straight edges. */
function withTouching(box, rules) {
    const out = { ...box };
    let grew = true;
    const left = [...rules];
    while (grew) {
        grew = false;
        for (let i = left.length - 1; i >= 0; i--) {
            const r = left[i];
            if (r.x0 <= out.x1 + 2 && r.x1 >= out.x0 - 2 && r.y0 <= out.y1 + 2 && r.y1 >= out.y0 - 2) {
                out.x0 = Math.min(out.x0, r.x0); out.y0 = Math.min(out.y0, r.y0);
                out.x1 = Math.max(out.x1, r.x1); out.y1 = Math.max(out.y1, r.y1);
                left.splice(i, 1);
                grew = true;
            }
        }
    }
    return out;
}

/** Boxes that touch or come within `gap` points of each other, merged. */
function clusters(boxes, gap) {
    let out = boxes.map(plainBox);
    for (let changed = true; changed;) {
        changed = false;
        const next = [];
        for (const b of out) {
            const o = next.find((n) => b.x0 <= n.x1 + gap && n.x0 <= b.x1 + gap && b.y0 <= n.y1 + gap && n.y0 <= b.y1 + gap);
            if (o) {
                o.x0 = Math.min(o.x0, b.x0); o.y0 = Math.min(o.y0, b.y0);
                o.x1 = Math.max(o.x1, b.x1); o.y1 = Math.max(o.y1, b.y1);
                changed = true;
            } else next.push(b);
        }
        out = next;
    }
    return out;
}

function plainBox(b) {
    return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

function boxOf(boxes) {
    return {
        x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
        x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
    };
}

function itemBox(it) {
    return { x0: it.x, x1: it.x + it.w, y0: it.inkTop ?? it.y - 0.75 * it.h, y1: it.inkBottom ?? it.y + DESCENT * it.h };
}

function centre(b) {
    const x = (b.x0 + b.x1) / 2;
    const y = (b.y0 + b.y1) / 2;
    return { x0: x, x1: x, y0: y, y1: y };
}

function contains(outer, inner, slack = 0) {
    return inner.x0 >= outer.x0 - slack && inner.x1 <= outer.x1 + slack && inner.y0 >= outer.y0 - slack && inner.y1 <= outer.y1 + slack;
}

// ─── Lines ──────────────────────────────────────────────────────────────────

/**
 * Items whose baselines sit within half a font size share a line, which
 * keeps a superscript with the base text it belongs to.
 * @param {TextItem[]} items
 */
export function buildLines(items) {
    const sorted = items
        .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '' && it.h > 0)
        .sort((a, b) => a.y - b.y || a.x - b.x);

    const lines = [];
    for (const item of sorted) {
        const line = lines.find((l) => Math.abs(item.y - l.y) <= 0.5 * Math.max(l.size, item.h));
        if (line) {
            line.items.push(item);
            if (item.h > line.size && item.math === undefined) { line.size = item.h; line.y = item.y; }
        } else {
            lines.push({ y: item.y, size: item.h, items: [item] });
        }
    }

    for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        line.left = line.items[0].x;
        line.right = Math.max(...line.items.map((it) => it.x + it.w));
        line.inkTop = Math.min(...line.items.map((it) => itemBox(it).y0));
        line.inkBottom = Math.max(...line.items.map((it) => itemBox(it).y1));
        line.segments = segmentsOf(line);
        line.runs = runsOf(line.items, line);
        line.plain = line.runs.map((r) => r.text).join('');
    }
    return lines.sort((a, b) => a.y - b.y);
}

/** A line split where a gap is wider than any word space: tab-separated parts. */
function segmentsOf(line) {
    const segments = [];
    let current = null;
    for (const it of line.items) {
        if (current && it.x - current.x1 > Math.max(SEGMENT_GAP * line.size, 12)) current = null;
        if (!current) {
            current = { x0: it.x, x1: it.x + it.w, items: [] };
            segments.push(current);
        }
        current.items.push(it);
        current.x1 = Math.max(current.x1, it.x + it.w);
    }
    return segments;
}

function runsOf(items, line) {
    const runs = [];
    let prev = null;
    const plain = { bold: false, italic: false, script: null, size: null, family: null };

    for (const item of items) {
        let space = false;
        if (prev) {
            const gap = item.x - (prev.x + prev.w);
            space = gap > 0.15 * line.size && !/\s$/.test(prev.str) && !/^\s/.test(item.str);
        }
        if (item.math !== undefined || item.crop !== undefined) {
            if (space) runs.push({ text: ' ', ...plain });
            runs.push(item.math !== undefined
                ? { text: item.str, math: item.math, ...plain }
                : { text: '', crop: item.crop, width: item.w, drop: item.inkBottom - item.y, ...plain });
            prev = item;
            continue;
        }

        const script = item.h < 0.85 * line.size && item.y < line.y - 0.15 * line.size ? 'sup'
            : item.h < 0.85 * line.size && item.y > line.y + 0.1 * line.size ? 'sub'
                : null;
        // A script's size is the editor's to choose; Word shrinks it itself.
        const style = {
            bold: !!item.bold, italic: !!item.italic, script,
            size: script ? null : Math.round(item.h * 2) / 2,
            family: fontFamilyOf(item.fontName),
        };
        const str = space ? ' ' + item.str : item.str;
        const last = runs[runs.length - 1];
        if (last && last.math === undefined && last.crop === undefined && ['bold', 'italic', 'script', 'size', 'family'].every((k) => last[k] === style[k])) {
            last.text += str;
        } else {
            runs.push({ text: str, ...style });
        }
        prev = item;
    }
    return runs;
}

/** Baseline-to-baseline distance of consecutive lines, per font size, across the document. */
function linePitches(pages) {
    const samples = new Map();
    const add = (lines) => {
        for (let i = 1; i < lines.length; i++) {
            const a = lines[i - 1];
            const b = lines[i];
            const d = b.y - a.y;
            if (Math.abs(a.size - b.size) > 0.25 || d < a.size || d > 1.6 * a.size) continue;
            // A line with a fraction in it is taller than its pitch.
            if (a.inkTop < a.y - a.size || b.inkTop < b.y - b.size) continue;
            const key = Math.round(a.size * 2) / 2;
            if (!samples.has(key)) samples.set(key, []);
            samples.get(key).push(d);
        }
    };
    for (const page of pages) {
        add(page.lines);
        for (const lines of page.cellLines.values()) add(lines);
    }
    const pitches = new Map();
    for (const [size, ds] of samples) pitches.set(size, median(ds));
    return (size) => pitches.get(Math.round(size * 2) / 2) || SINGLE_LINE * size;
}

// ─── Pages and margins ──────────────────────────────────────────────────────

/**
 * One set of margins per page shape (portrait, landscape), from the extent
 * of everything on the pages of that shape: Word lays a page out against
 * its margins, so text that ran margin to margin still does.
 */
function marginsOf(pages, pitch) {
    const shape = (page) => `${Math.round(page.width)}x${Math.round(page.height)}`;
    const extents = new Map();
    for (const page of pages) {
        const boxes = [
            ...page.lines.map((l) => ({ x0: l.left, x1: l.right, y0: l.y - above(l, pitch(l.size)), y1: l.y + below(l) })),
            ...page.tables,
            ...page.figures.filter((f) => !f.scan),
        ];
        if (boxes.length === 0) continue;
        const b = boxOf(boxes);
        const e = extents.get(shape(page));
        extents.set(shape(page), e ? boxOf([e, b]) : b);
    }
    return pages.map((page) => {
        const e = extents.get(shape(page));
        if (!e) return { top: SCAN_MARGIN, right: SCAN_MARGIN, bottom: SCAN_MARGIN, left: SCAN_MARGIN };
        const bottom = Math.max(0, page.height - e.y1);
        return {
            top: Math.max(0, e.y0),
            left: Math.max(0, e.x0),
            right: Math.max(0, page.width - e.x1),
            // Half the room it had: a page set a little taller in Word still fits.
            bottom: Math.max(Math.min(bottom, 6), bottom / 2),
        };
    });
}

function above(line, pitch) {
    return Math.max(pitch - DESCENT * line.size, line.y - line.inkTop);
}

function below(line) {
    return Math.max(DESCENT * line.size, line.inkBottom - line.y);
}

/** One page as a <section> of its size and margins, its blocks spaced as the PDF spaced them. */
function renderPage(page, margins, ctx) {
    const box = { x0: margins.left, x1: page.width - margins.right, y0: margins.top };
    const blocks = [];

    const inline = page.pageFigures.filter((f) => !floats(f, page.lines));
    const floating = page.pageFigures.filter((f) => !inline.includes(f));
    for (const row of figureRows(inline)) blocks.push(figureBlock(row, box, ctx));
    for (const table of page.tables) blocks.push(tableBlock(table, page, ctx));
    blocks.push(...flow(page.lines, box, ctx, true));
    blocks.sort((a, b) => a.top - b.top);

    // A floating picture rides in the paragraph nearest above it, placed on the page.
    for (const f of floating) {
        const img = imageHtml(f, ctx, ` data-float="${pt(f.x0)} ${pt(f.y0)}"`);
        if (!img) continue;
        const host = [...blocks].reverse().find((b) => b.kind === 'p' && b.top <= f.y0) || blocks.find((b) => b.kind === 'p');
        if (host) host.floats.push(img);
        else blocks.push(emptyBlock(f.y0, [img]));
    }

    const geometry = `data-page="${pt(page.width)} ${pt(page.height)}" data-margins="${pt(margins.top)} ${pt(margins.right)} ${pt(margins.bottom)} ${pt(margins.left)}"`;
    return {
        html: `<section ${geometry}>\n${spaced(blocks, box.y0)}\n</section>`,
        text: blocks.map((b) => b.text).filter(Boolean).join('\n\n'),
    };
}

function emptyBlock(top, floatsHtml) {
    return {
        kind: 'p', top, bottom: top, floats: floatsHtml, text: '',
        render(before, after) {
            return paragraph({ before, after }, '', this.floats);
        },
    };
}

/**
 * Blocks to HTML, each spaced from the one before by the distance between
 * them on the page. A table cannot take space before itself in Word, so
 * the paragraph above it takes the space after instead.
 */
function spaced(blocks, top) {
    const out = [];
    let bottom = top;
    blocks.forEach((block, i) => {
        const gap = Math.max(0, block.top - bottom);
        const next = blocks[i + 1];
        const after = next && next.kind === 'table' && block.kind !== 'table' ? Math.max(0, next.top - block.bottom) : 0;
        if (block.kind === 'table' && gap > 1 && (i === 0 || blocks[i - 1].kind === 'table')) out.push(spacer(gap));
        const html = block.render(block.kind === 'table' ? 0 : gap, after);
        if (html) out.push(html);
        bottom = Math.max(bottom, block.bottom);
    });
    return out.join('\n');
}

function spacer(height) {
    return `<p style="margin:0;font-size:1pt;line-height:${pt(height)}pt;mso-line-height-rule:exactly"></p>`;
}

// ─── Flow: paragraphs, tab stops and side-by-side columns ───────────────────

/**
 * Lines inside one container (the page's text area or a cell) as blocks.
 * @param {object[]} lines
 * @param {{x0: number, x1: number, y0: number}} box  The container's text edges.
 * @param {boolean} columns  Whether lines may form side-by-side columns.
 */
function flow(lines, box, ctx, columns) {
    nearPitches(lines);
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.segments.length > 1) {
            const band = columns ? bandFrom(lines, i) : null;
            if (band) {
                blocks.push(bandBlock(band, box, ctx));
                i = band.end;
            } else {
                blocks.push(tabsBlock(line, box, ctx));
                i++;
            }
            continue;
        }
        const para = [line];
        while (i + para.length < lines.length && continues(para[para.length - 1], lines[i + para.length], box, ctx)) {
            para.push(lines[i + para.length]);
        }
        blocks.push(paragraphBlock(para, box, ctx));
        i += para.length;
    }
    return blocks;
}

/**
 * Each line's distance to its nearest neighbour set as plain text of its
 * size: the pitch a one-line paragraph was set at, which nothing else shows.
 */
function nearPitches(lines) {
    const plain = (l) => l.inkTop >= l.y - l.size && l.inkBottom <= l.y + 0.4 * l.size;
    lines.forEach((line, k) => {
        const ds = [lines[k - 1], lines[k + 1]].filter(Boolean).map((o) => {
            const d = Math.abs(line.y - o.y);
            const ok = plain(line) && plain(o) && Math.abs(o.size - line.size) <= 0.25 && d >= 0.85 * line.size && d <= 1.6 * line.size;
            return ok ? d : Infinity;
        });
        const near = Math.min(...ds, Infinity);
        line.near = Number.isFinite(near) ? near : null;
    });
}

/** A line's pitch: its neighbours', else the document's for its size, never more than its cell allows. */
function pitchOf(line, ctx) {
    return Math.min(line.near ?? ctx.pitches(line.size), line.room ?? Infinity);
}

/**
 * Word's single spacing is the least 'at least' can give; a PDF set tighter
 * than that was set exactly, which only text without tall equations survives.
 */
function exactly(lines, pitch) {
    return lines.every((l) => l.inkTop >= l.y - l.size) && pitch < 0.98 * SINGLE_LINE * Math.max(...lines.map((l) => l.size));
}

/**
 * A line continues the paragraph above when it is the text that did not
 * fit there: its first word would have run past the right edge.
 */
function continues(prev, line, box, ctx) {
    if (line.segments.length > 1) return false;
    if (Math.abs(line.size - prev.size) > 0.15 * prev.size) return false;
    const pitch = ctx.pitches(prev.size);
    if (line.y - prev.y > Math.max(1.5 * prev.size, 1.25 * pitch)) return false;
    if (line.left > prev.left + 1.5 * line.size) return false;
    if (BLOCK_START.test(line.plain)) return false;
    const next = 0.25 * line.size + firstWordWidth(line);
    // A centred line wraps by its width, not by where it ends.
    const middle = (box.x0 + box.x1) / 2;
    const centred = Math.abs((prev.left + prev.right) / 2 - middle) < Math.max(3, 0.02 * (box.x1 - box.x0)) &&
        prev.left - box.x0 > Math.max(2, 0.5 * prev.size);
    if (centred) return prev.right - prev.left + next > box.x1 - box.x0 - 1;
    return prev.right + next > box.x1 - 1;
}

function firstWordWidth(line) {
    const it = line.items[0];
    if (it.math !== undefined) return it.w;
    const word = /^\s*\S+/.exec(it.str)?.[0] || it.str;
    return it.w * [...word].length / Math.max(1, [...it.str].length);
}

function paragraphBlock(lines, box, ctx) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    const gaps = lines.slice(1).map((l, k) => l.y - lines[k].y);
    const pitch = gaps.length ? median(gaps) : pitchOf(first, ctx);
    const exact = exactly(lines, pitch);
    const width = box.x1 - box.x0;

    const runs = [];
    lines.forEach((line, k) => {
        if (k > 0) runs.push({ text: ' ', bold: false, italic: false, script: null, size: null, family: null });
        runs.push(...line.runs);
    });

    const middle = (box.x0 + box.x1) / 2;
    // Centred: every line on the middle, and some line short of both edges.
    const centred = lines.every((l) => Math.abs((l.left + l.right) / 2 - middle) < Math.max(3, 0.02 * width)) &&
        lines.some((l) => l.left - box.x0 > Math.max(2, 0.5 * l.size));
    const right = !centred && first.left - box.x0 > 0.3 * width && lines.every((l) => Math.abs(l.right - box.x1) < 3);
    const justified = !centred && lines.length > 1 && lines.slice(0, -1).every((l) => l.right >= box.x1 - 3);

    const rest = lines.slice(1);
    const left = centred || right ? 0 : indent((rest.length ? Math.min(...rest.map((l) => l.left)) : first.left) - box.x0);
    const firstLine = centred || right ? 0 : indent(first.left - box.x0 - left, true);
    const html = runsHtml(runs, ctx);

    return {
        kind: 'p',
        top: first.y - Math.max(pitch - DESCENT * first.size, first.y - first.inkTop),
        bottom: last.y + below(last),
        floats: [],
        text: runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim(),
        render(before, after) {
            return paragraph({
                before, after, left, firstLine, pitch, exact,
                align: centred ? 'center' : right ? 'right' : justified ? 'justify' : null,
            }, html, this.floats);
        },
    };
}

/** One line of parts at tab stops: answer choices, captions under figures. */
function tabsBlock(line, box, ctx) {
    const [first, ...others] = line.segments;
    const left = indent(first.x0 - box.x0);
    const stops = others.map((s) => s.x0 - box.x0);
    const parts = line.segments.map((s) => runsOf(s.items, line));
    let html = runsHtml(parts[0], ctx);
    others.forEach((s, k) => {
        const width = Math.max(1, s.x0 - line.segments[k].x1);
        html += `<span data-tab style="display:inline-block;width:${pt(width)}pt"></span>${runsHtml(parts[k + 1], ctx)}`;
    });
    const pitch = pitchOf(line, ctx);
    const exact = exactly([line], pitch);
    return {
        kind: 'p',
        top: line.y - above(line, pitch),
        bottom: line.y + below(line),
        floats: [],
        text: parts.map((runs) => runs.map((r) => r.text).join('').trim()).join('\t'),
        render(before, after) {
            return paragraph({ before, after, left, firstLine: 0, pitch, exact, tabs: stops }, html, this.floats);
        },
    };
}

/**
 * Consecutive lines whose parts stay on either side of the same gaps:
 * columns set side by side, like a letterhead beside a title. Lines whose
 * parts all start at the same places are tab stops, not columns.
 * @returns {{lines: object[], gutters: Array<{a: number, b: number}>, end: number, columnOf: Function}|null}
 */
function bandFrom(lines, i) {
    const start = lines[i];
    let gutters = start.segments.slice(1).map((s, k) => ({ a: start.segments[k].x1, b: s.x0 }));
    let end = i + 1;
    while (end < lines.length) {
        const line = lines[end];
        const prev = lines[end - 1];
        if (line.y - prev.y > 2.2 * Math.max(prev.size, line.size)) break;
        // Text over a gutter's middle ends the band; text into its sides narrows it.
        if (line.items.some((it) => gutters.some((g) => it.x < (g.a + g.b) / 2 && it.x + it.w > (g.a + g.b) / 2))) break;
        const narrowed = gutters.map((g) => {
            let { a, b } = g;
            for (const it of line.items) {
                if (it.x + it.w / 2 < (g.a + g.b) / 2) a = Math.max(a, it.x + it.w);
                else b = Math.min(b, it.x);
            }
            return { a, b };
        });
        if (narrowed.some((g) => g.b - g.a < 6)) break;
        gutters = narrowed;
        end++;
    }
    if (end - i < 2) return null;

    const band = lines.slice(i, end);
    const columnOf = (it) => gutters.filter((g) => it.x + it.w / 2 > g.b).length;
    const starts = [...gutters, null].map(() => []);
    for (const line of band) {
        const seen = new Set();
        for (const it of line.items) {
            const c = columnOf(it);
            if (!seen.has(c)) { starts[c].push(it.x); seen.add(c); }
        }
    }
    const aligned = starts.every((xs) => xs.length === 0 || Math.max(...xs) - Math.min(...xs) < 2);
    if (aligned && band.every((l) => columnOf(l.items[0]) === 0)) return null;
    return { lines: band, gutters, end, columnOf };
}

/** A band as a borderless one-row table, a cell per column. */
function bandBlock(band, box, ctx) {
    const edges = [box.x0 - CELL_PAD, ...band.gutters.map((g) => (g.a + g.b) / 2), box.x1 + CELL_PAD];
    nearPitches(band.lines);
    const top = Math.min(...band.lines.map((l) => l.y - above(l, pitchOf(l, ctx))));
    const bottom = Math.max(...band.lines.map((l) => l.y + below(l)));
    const cells = edges.slice(0, -1).map((x0, c) => {
        const items = band.lines.flatMap((l) => l.items).filter((it) => band.columnOf(it) === c);
        const inner = { x0: x0 + CELL_PAD, x1: edges[c + 1] - CELL_PAD, y0: top };
        return { x0, x1: edges[c + 1], blocks: flow(buildLines(items), inner, ctx, false) };
    });
    const cols = cells.map((c) => `<col style="width:${pt(c.x1 - c.x0)}pt">`).join('');
    const tds = cells.map((c) => `<td style="border:none;vertical-align:top;padding:0 ${CELL_PAD}pt">${spaced(c.blocks, top) || EMPTY_CELL}</td>`).join('');
    const html = `<table style="margin-left:${pt(box.x0 - ctx.marginLeft - CELL_PAD)}pt;width:${pt(edges[edges.length - 1] - edges[0])}pt;table-layout:fixed;border-collapse:collapse">` +
        `<colgroup>${cols}</colgroup><tr style="height:${pt(bottom - top)}pt">${tds}</tr></table>`;
    return {
        kind: 'table', top, bottom, floats: [],
        text: cells.map((c) => c.blocks.map((b) => b.text).join(' ')).join('\t'),
        render: () => html,
    };
}

// ─── Tables ─────────────────────────────────────────────────────────────────

function tableBlock(table, page, ctx) {
    const { xs, ys } = table;
    const rows = ys.slice(0, -1).map(() => []);
    for (const cell of table.cells) rows[cell.row].push(cell);

    // The table's own cell padding: no line comes closer to a cell's edge.
    const slack = table.cells.flatMap((c) => (page.cellLines.get(c) || []).flatMap((l) => [l.left - c.x0, c.x1 - l.right]));
    const pad = slack.length ? Math.max(0, Math.min(CELL_PAD, Math.min(...slack) - 0.3)) : CELL_PAD;

    const texts = new Map();
    const cellHtml = (cell) => {
        const inner = { x0: cell.x0 + pad, x1: cell.x1 - pad, y0: cell.y0 };
        const lines = page.cellLines.get(cell) || [];
        // A row is as tall as its lines: none may be set taller than its share.
        for (const l of lines) l.room = (cell.y1 - cell.y0) / lines.length;
        const blocks = flow(lines, inner, ctx, false);
        for (const row of figureRows(cell.figures)) blocks.push(figureBlock(row, inner, ctx));
        blocks.sort((a, b) => a.top - b.top);
        texts.set(cell, blocks.map((b) => b.text).filter(Boolean).join(' '));

        // Text centred in the cell is set middle; text at its top keeps its offset.
        let valign = 'top';
        let start = cell.y0;
        if (blocks.length > 0) {
            const top = Math.min(...blocks.map((b) => b.top));
            const bottom = Math.max(...blocks.map((b) => b.bottom));
            const slack = cell.y1 - cell.y0 - (bottom - top);
            if (slack > 4 && Math.abs((top + bottom) / 2 - (cell.y0 + cell.y1) / 2) < Math.max(2, 0.15 * slack)) {
                valign = 'middle';
                start = top;
            } else if (slack > 4 && cell.y1 - bottom < 2) {
                valign = 'bottom';
                start = top;
            }
        }
        const b = cell.borders;
        const side = (name, w) => `border-${name}:${w ? `${pt(w)}pt solid #000000` : 'none'}`;
        const style = [
            side('top', b.top), side('right', b.right), side('bottom', b.bottom), side('left', b.left),
            `vertical-align:${valign}`, `padding:0 ${pt(pad)}pt`,
            cell.fill ? `background-color:${cell.fill}` : '',
        ].filter(Boolean).join(';');
        const span = `${cell.cols > 1 ? ` colspan="${cell.cols}"` : ''}${cell.rows > 1 ? ` rowspan="${cell.rows}"` : ''}`;
        return `<td${span} style="${style}">${spaced(blocks, start) || EMPTY_CELL}</td>`;
    };

    const body = rows.map((cells, r) => `<tr style="height:${pt(ys[r + 1] - ys[r])}pt">${cells.map(cellHtml).join('')}</tr>`).join('\n');
    const cols = xs.slice(0, -1).map((x, c) => `<col style="width:${pt(xs[c + 1] - x)}pt">`).join('');
    const html = `<table style="margin-left:${pt(table.x0 - ctx.marginLeft)}pt;width:${pt(table.x1 - table.x0)}pt;table-layout:fixed;border-collapse:collapse">` +
        `<colgroup>${cols}</colgroup>\n${body}\n</table>`;
    return {
        kind: 'table', top: table.y0, bottom: table.y1, floats: [],
        text: rows.map((cells) => cells.map((c) => texts.get(c) || '').join('\t')).join('\n'),
        render: () => html,
    };
}

// ─── Figures ────────────────────────────────────────────────────────────────

/** A figure beside text on its lines cannot sit in the flow; it floats where it was. */
function floats(figure, lines) {
    return lines.some((l) => {
        const overlap = Math.min(l.inkBottom, figure.y1) - Math.max(l.inkTop, figure.y0);
        return overlap > 0.3 * (l.inkBottom - l.inkTop) && (l.right <= figure.x0 + 1 || l.left >= figure.x1 - 1);
    });
}

/** Figures side by side (their heights overlapping) as one row. */
function figureRows(figures) {
    const rows = [];
    for (const f of [...figures].sort((a, b) => a.y0 - b.y0)) {
        const row = rows.find((r) => r.some((o) => Math.min(o.y1, f.y1) - Math.max(o.y0, f.y0) > 0.5 * Math.min(o.y1 - o.y0, f.y1 - f.y0)));
        if (row) row.push(f);
        else rows.push([f]);
    }
    return rows.map((r) => r.sort((a, b) => a.x0 - b.x0));
}

/** A row of figures as one paragraph, each at its own place by tab stops. */
function figureBlock(row, box, ctx) {
    const top = Math.min(...row.map((f) => f.y0));
    const bottom = Math.max(...row.map((f) => f.y1));
    const width = box.x1 - box.x0;
    const single = row.length === 1 ? row[0] : null;
    const centred = Boolean(single) && Math.abs((single.x0 + single.x1) / 2 - (box.x0 + box.x1) / 2) < Math.max(4, 0.03 * width);
    const left = centred ? 0 : indent(row[0].x0 - box.x0);
    const stops = row.slice(1).map((f) => f.x0 - box.x0);
    let html = '';
    row.forEach((f, k) => {
        if (k > 0) html += `<span data-tab style="display:inline-block;width:${pt(Math.max(1, f.x0 - row[k - 1].x1))}pt"></span>`;
        html += imageHtml(f, ctx, '');
    });
    return {
        kind: 'p', top, bottom, floats: [], text: '',
        render(before, after) {
            if (!html && this.floats.length === 0) return '';
            return paragraph({ before, after, left, firstLine: 0, tabs: stops, align: centred ? 'center' : null, picture: true }, html, this.floats);
        },
    };
}

function imageHtml(figure, ctx, attrs) {
    const crop = ctx.crops[figure.index];
    if (!crop?.src) return '';
    return `<img src="${crop.src}" width="${Math.round((figure.x1 - figure.x0) * PX_PER_PT)}"${attrs} alt="">`;
}

// ─── HTML ───────────────────────────────────────────────────────────────────

/**
 * A <p> with its geometry as inline style: popup/docx.js writes each as the
 * Word property it names, and a browser draws it the same way.
 */
function paragraph({ before = 0, after = 0, left = 0, firstLine = 0, pitch, exact, align, tabs, picture }, inner, floatsHtml = []) {
    const style = [
        `margin:${pt(before)}pt 0 ${pt(after)}pt ${pt(left)}pt`,
        firstLine ? `text-indent:${pt(firstLine)}pt` : '',
        align ? `text-align:${align}` : '',
        pitch && !picture ? `line-height:${pt(pitch)}pt` : '',
        pitch && !picture && exact ? 'mso-line-height-rule:exactly' : '',
        picture ? 'line-height:1;font-size:1pt' : '',
    ].filter(Boolean).join(';');
    const tabAttr = tabs && tabs.length ? ` data-tabs="${tabs.map(pt).join(' ')}"` : '';
    return `<p style="${style}"${tabAttr}>${floatsHtml.join('')}${inner}</p>`;
}

/** Runs inside a span of their commonest font and size, each run stating only a difference. */
function runsHtml(runs, ctx) {
    const base = { size: commonest(runs, 'size'), family: commonest(runs, 'family') };
    const inner = runs.map((r) => runHtml(r, base, ctx)).join('').trim();
    const css = fontCss(base);
    return css ? `<span style="${css}">${inner}</span>` : inner;
}

function runHtml(run, base, ctx) {
    if (run.math !== undefined) return `<span data-ole="${run.math}">${escapeHtml(run.text)}</span>`;
    if (run.crop !== undefined) {
        const src = ctx.crops[run.crop]?.src;
        // Lowered by its descent: Word and browsers both sit a picture on the baseline.
        return src ? `<img src="${src}" width="${Math.round(run.width * PX_PER_PT)}" style="vertical-align:${pt(-Math.max(0, run.drop))}pt" alt="">` : '';
    }
    let html = escapeHtml(run.text);
    if (run.script) html = `<${run.script}>${html}</${run.script}>`;
    if (run.italic) html = `<i>${html}</i>`;
    if (run.bold) html = `<b>${html}</b>`;
    const own = fontCss({
        size: run.size && run.size !== base.size ? run.size : null,
        family: run.family && run.family !== base.family ? run.family : null,
    });
    return own && run.text.trim() ? `<span style="${own}">${html}</span>` : html;
}

function fontCss({ size, family }) {
    return [family ? `font-family:'${family}'` : '', size ? `font-size:${size}pt` : ''].filter(Boolean).join(';');
}

/** The value of `key` covering the most characters, ignoring blanks. */
function commonest(runs, key) {
    const counts = new Map();
    for (const run of runs) {
        if (run[key]) counts.set(run[key], (counts.get(run[key]) || 0) + run.text.trim().length);
    }
    let best = null;
    for (const [value, n] of counts) if (best === null || n > counts.get(best)) best = value;
    return best;
}

/** An indent in points, a hair's offset read as none. */
function indent(value, signed = false) {
    const v = Math.round(value * 2) / 2;
    if (Math.abs(v) < 1) return 0;
    return signed ? v : Math.max(0, v);
}

function pt(n) {
    return String(Math.round(n * 100) / 100);
}

/**
 * A PDF font's family as Word names it: `ABCDEF+TimesNewRomanPS-BoldMT` is
 * Times New Roman. Legacy Vietnamese fonts keep their own name, which is
 * what makes their text readable where the font is installed.
 * @param {string|undefined} fontName
 * @returns {string|null} null for a name that is no family (Type 3 `g_d0_f1`).
 */
export function fontFamilyOf(fontName) {
    let name = String(fontName || '').replace(/^[A-Z]{6}\+/, '');
    name = name.replace(FONT_STYLE, '').replace(/(PS)?MT$/, '').replace(/PS$/, '');
    if (!name || /[\d_]/.test(name) || /[^\w .-]/.test(name)) return null;
    if (isLegacyVnFont(name)) return name;
    const [first, second] = name.split(/[-,]/);
    // `MT-Extra`, `MS-Mincho`: a maker's prefix, not the family.
    if (/^[A-Z]{1,3}$/.test(first) && second) return `${first} ${second}`;
    return FONT_NAMES[first.toLowerCase()] || first.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] || 0;
}
