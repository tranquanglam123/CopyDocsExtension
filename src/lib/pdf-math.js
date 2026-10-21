/**
 * An equation drawn in a PDF, rebuilt as Office Math. MathType and Word
 * draw an equation as positioned glyphs plus a few paths: a bar per
 * fraction, a hooked outline per radical. Their geometry gives the
 * structure back: what sits over a bar is its numerator, what sits under
 * a radical's roof its radicand, a smaller raised glyph a superscript.
 */
import { escapeHtml } from './html.js';

/** Thinner than this (points) and wider than tall, a path is a bar. */
const BAR_MAX_THICKNESS = 1.6;

/** MathType's MT Extra arcs, drawn over a letter: an angle's hat. */
const ARC_ACCENTS = new Set(['', '']);
const ARC = '̑';

/** Fences MathType stretches; taller than the row, they wrap what is between. */
const OPEN_FENCES = { '(': ')', '[': ']', '{': '}', '|': '|' };

/**
 * The Symbol font's pieces of a stretched fence (top, extension, middle,
 * bottom), which pdf.js leaves in the private-use area. Stacked in one
 * column they are one tall fence.
 */
const FENCE_PIECES = {
    '': '(', '': '(', '': '(',
    '': '[', '': '[', '': '[',
    '': '{', '': '{', '': '{', '': '{',
    '': ')', '': ')', '': ')',
    '': ']', '': ']', '': ']',
    '': '}', '': '}', '': '}',
    '': '|',
};

const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '−': '⁻', '-': '⁻', n: 'ⁿ' };
const SUBSCRIPT = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '−': '₋', '-': '₋' };

/**
 * @typedef {{str: string, x: number, y: number, w: number, h: number, italic?: boolean, fontName?: string}} Glyph
 * @typedef {{x0: number, y0: number, x1: number, y1: number, points?: number[][], fill?: string|null, stroke?: boolean, lineWidth?: number}} Shape
 * @typedef {{omml: string, linear: string, x0: number, y0: number, x1: number, y1: number, baseline: number, size: number}} Equation
 */

/**
 * Whether an equation's glyphs all read as what they draw: a character in
 * the private-use area means a MathType font symbol this does not know,
 * which neither Word's math font nor any other would draw.
 * @param {Glyph[]} glyphs
 */
export function readable(glyphs) {
    const known = (c) => FENCE_PIECES[c] || ARC_ACCENTS.has(c);
    return glyphs.every((g) => [...g.str].every((c) => c.codePointAt(0) < 0xE000 || c.codePointAt(0) > 0xF8FF || known(c)));
}

/**
 * @param {Glyph[]} glyphs  The equation's text runs.
 * @param {Shape[]} shapes  Its paths.
 * @returns {Equation|null}  null when it has no structure text cannot carry
 *   (then its glyphs read fine as runs), or has a shape this cannot place.
 */
export function buildEquation(glyphs, shapes) {
    const pieces = glyphs.filter((g) => FENCE_PIECES[g.str.trim()]);
    const atoms = [
        ...glyphs.filter((g) => g.str.trim() !== '' && g.h > 0 && !pieces.includes(g)).flatMap(splitWords).map(glyphAtom),
        ...stackFences(pieces),
    ];
    if (atoms.length === 0) return null;

    const bars = [];
    const marks = [];
    for (const s of shapes) {
        const w = s.x1 - s.x0;
        const h = s.y1 - s.y0;
        if (h <= BAR_MAX_THICKNESS && w > 2 * Math.max(h, 0.5)) bars.push({ x0: s.x0, x1: s.x1, y: (s.y0 + s.y1) / 2 });
        else marks.push(s);
    }
    const radicals = radicalsOf(marks);
    if (radicals === null) return null;
    // A bar drawn as the radical's roof belongs to the radical.
    const freeBars = bars.filter((b) => !radicals.some((r) => b.y <= r.y0 + 2 && b.x0 >= r.roof - 2 && b.x1 <= r.x1 + 2));

    const accents = atoms.filter((a) => ARC_ACCENTS.has(a.str.trim()));
    if (freeBars.length === 0 && radicals.length === 0 && accents.length === 0 && pieces.length === 0) return null;

    const constructs = [
        ...freeBars.map((b) => ({ kind: 'frac', x0: b.x0, x1: b.x1, y: b.y })),
        ...radicals.map((r) => ({ kind: 'rad', x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, roof: r.roof })),
    ];
    const size = mainSize(atoms);
    const lines = linesOf(atoms.filter((a) => !accents.includes(a)), constructs, size);
    const tree = lines.length > 1
        ? [{ kind: 'stack', rows: lines.map((l) => build(l.atoms, l.constructs, accents.filter((a) => l.atoms.some((p) => overlaps(a, p))))) }]
        : build(atoms.filter((a) => !accents.includes(a)), constructs, accents);

    // Ink only: the spaces MathType draws at either end are the text's to keep.
    const xs = [...atoms.map((a) => a.x), ...shapes.map((s) => s.x0)];
    const xe = [...atoms.map((a) => a.x1), ...shapes.map((s) => s.x1)];
    const ys = [...atoms.map((a) => a.y - 0.75 * a.h), ...shapes.map((s) => s.y0)];
    const ye = [...atoms.map((a) => a.y + 0.25 * a.h), ...shapes.map((s) => s.y1)];
    return {
        omml: `<m:oMath>${omml(tree, size)}</m:oMath>`,
        linear: linear(tree).trim(),
        x0: Math.min(...xs), x1: Math.max(...xe), y0: Math.min(...ys), y1: Math.max(...ye),
        baseline: baselineOf(tree, atoms, size),
        size,
    };
}

/**
 * A run with spaces split into its words, placed in proportion to their
 * length: in an equation a run like `AH AH` can have a glyph drawn into its gap.
 * @template {{str: string, x: number, w: number}} T
 * @param {T} g
 * @returns {T[]}
 */
export function splitWords(g) {
    if (!/\S\s+\S/.test(g.str)) return [g];
    const chars = [...g.str];
    const per = g.w / chars.length;
    const out = [];
    let at = 0;
    for (const part of g.str.split(/(\s+)/)) {
        const n = [...part].length;
        if (part.trim()) out.push({ ...g, str: part, x: g.x + at * per, w: n * per });
        at += n;
    }
    return out;
}

function glyphAtom(g) {
    return { kind: 'text', str: g.str, x: g.x, x1: g.x + g.w, y: g.y, h: g.h, cy: g.y - 0.3 * g.h, italic: Boolean(g.italic) };
}

/**
 * An equation of several lines (a derivation, a pile) split into them. A
 * line's baseline is where full-size glyphs outside any fraction or radical
 * sit, or a fraction's axis; a numerator above its bar starts no line.
 * @returns {Array<{atoms: object[], constructs: object[]}>}  One entry for a one-line equation.
 */
function linesOf(atoms, constructs, size) {
    const zone = (c) => c.kind === 'frac'
        ? { x0: c.x0, x1: c.x1, y0: c.y - 1.6 * size, y1: c.y + 1.6 * size }
        : { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 + 0.3 * size };
    const zones = constructs.map((c) => ({ c, ...zone(c) }));
    const owner = (a) => zones.find((z) => (a.x + a.x1) / 2 >= z.x0 - 1 && (a.x + a.x1) / 2 <= z.x1 + 1 && a.cy >= z.y0 && a.cy <= z.y1);

    const refs = [
        ...atoms.filter((a) => a.h >= 0.85 * size && a.h <= 1.3 * size && !owner(a)).map((a) => a.y),
        ...constructs.map((c) => (c.kind === 'frac' ? c.y + 0.27 * size : c.y1 - 0.25 * size)),
    ].sort((a, b) => a - b);
    const baselines = [];
    for (const y of refs) {
        if (baselines.length && y - baselines[baselines.length - 1].last < 0.6 * size) baselines[baselines.length - 1].last = y;
        else baselines.push({ first: y, last: y });
    }
    const gaps = baselines.slice(1).map((b, i) => b.first - baselines[i].last);
    if (baselines.length < 2 || gaps.some((g) => g < 1.2 * size)) return [{ atoms, constructs }];

    const nearest = (y) => {
        let best = 0;
        baselines.forEach((b, i) => { if (Math.abs((b.first + b.last) / 2 - y) < Math.abs((baselines[best].first + baselines[best].last) / 2 - y)) best = i; });
        return best;
    };
    const lines = baselines.map(() => ({ atoms: [], constructs: [] }));
    const lineOf = new Map();
    for (const z of zones) {
        const i = nearest(z.c.kind === 'frac' ? z.c.y + 0.27 * size : z.c.y1 - 0.25 * size);
        lineOf.set(z, i);
        lines[i].constructs.push(z.c);
    }
    for (const a of atoms) {
        const z = owner(a);
        lines[z ? lineOf.get(z) : nearest(a.y)].atoms.push(a);
    }
    return lines.filter((l) => l.atoms.length || l.constructs.length);
}

/** Fence pieces sharing a column as one atom as tall as the stack. */
function stackFences(pieces) {
    const columns = [];
    for (const g of [...pieces].sort((a, b) => a.y - b.y)) {
        const ch = FENCE_PIECES[g.str.trim()];
        const col = columns.find((c) => c.str === ch && Math.abs(c.x - g.x) < 1.5 && g.y - 0.8 * g.h <= c.bottom + 0.5 * g.h);
        if (col) col.bottom = g.y + 0.25 * g.h;
        else columns.push({ str: ch, x: g.x, x1: g.x + g.w, top: g.y - 0.75 * g.h, bottom: g.y + 0.25 * g.h, size: g.h });
    }
    return columns.map((c) => {
        const h = c.bottom - c.top;
        // Placed so its centre is the stack's: a row of its own height.
        return { kind: 'text', str: c.str, x: c.x, x1: c.x1, y: c.bottom - 0.25 * h, h, cy: (c.top + c.bottom) / 2, italic: false, fence: true };
    });
}

/**
 * Radicals from the non-bar shapes: MathType draws one as a hooked outline
 * whose top edge (the roof) runs over the radicand, often stroked and filled
 * as separate paths. Shapes that touch are one radical.
 * @returns {Array<{x0: number, y0: number, x1: number, y1: number, roof: number}>|null}
 *   null when a shape is no radical (a figure, a stretched fence).
 */
function radicalsOf(marks) {
    const clusters = [];
    for (const s of marks) {
        const near = clusters.filter((c) => s.x0 <= c.x1 + 1 && s.x1 >= c.x0 - 1 && s.y0 <= c.y1 + 1 && s.y1 >= c.y0 - 1);
        const merged = { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, points: [...(s.points || [])] };
        for (const c of near) {
            merged.x0 = Math.min(merged.x0, c.x0); merged.y0 = Math.min(merged.y0, c.y0);
            merged.x1 = Math.max(merged.x1, c.x1); merged.y1 = Math.max(merged.y1, c.y1);
            merged.points.push(...c.points);
            clusters.splice(clusters.indexOf(c), 1);
        }
        clusters.push(merged);
    }
    const out = [];
    for (const c of clusters) {
        const h = c.y1 - c.y0;
        const w = c.x1 - c.x0;
        // The roof starts where the outline's top edge does.
        const top = c.points.filter(([, y]) => y <= c.y0 + 1);
        const roof = top.length > 0 ? Math.min(...top.map(([x]) => x)) : c.x0;
        if (h < 4 || w < 0.5 * h || roof <= c.x0 + 0.1 * w || c.x1 - roof < 2) return null;
        out.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, roof });
    }
    return out;
}

/** The size most characters are set in: the equation's text size. */
function mainSize(atoms) {
    const counts = new Map();
    for (const a of atoms) {
        // A stretched fence is as tall as what it wraps, not the text's size.
        if (a.fence) continue;
        const key = Math.round(a.h * 2) / 2;
        counts.set(key, (counts.get(key) || 0) + a.str.trim().length);
    }
    let best = 0;
    for (const [size, n] of counts) if (!best || n > counts.get(best) || (n === counts.get(best) && size > best)) best = size;
    return best;
}

/**
 * A row of nodes from atoms and the constructs among them. The widest
 * constructs claim what lies over their span first, so a fraction inside a
 * radicand or a numerator nests rather than splits the row.
 */
function build(atoms, constructs, accents) {
    const pool = [...atoms];
    const nested = [...constructs];
    const top = constructs.filter((c) => !constructs.some((o) => o !== c && o.x0 <= c.x0 + 0.5 && o.x1 >= c.x1 - 0.5 && (o.x1 - o.x0) > (c.x1 - c.x0)));
    const nodes = [];

    for (const c of top.sort((a, b) => a.x0 - b.x0)) {
        nested.splice(nested.indexOf(c), 1);
        const left = c.kind === 'rad' ? c.roof - 1 : c.x0 - 1;
        const inside = (x0, x1) => (x0 + x1) / 2 >= left && (x0 + x1) / 2 <= c.x1 + 1;
        const takeAtoms = pool.filter((a) => inside(a.x, a.x1) && (c.kind === 'frac' || (a.cy >= c.y0 - 1 && a.cy <= c.y1 + 2)));
        const takeCons = nested.filter((o) => inside(o.x0, o.x1));
        for (const a of takeAtoms) pool.splice(pool.indexOf(a), 1);
        for (const o of takeCons) nested.splice(nested.indexOf(o), 1);
        const takeAccents = accents.filter((a) => inside(a.x, a.x1));

        if (c.kind === 'frac') {
            const above = (y) => y < c.y;
            const mid = (o) => (o.kind === 'frac' ? o.y : (o.y0 + o.y1) / 2);
            nodes.push({
                kind: 'frac', x: c.x0, x1: c.x1, y: c.y,
                num: build(takeAtoms.filter((a) => above(a.cy)), takeCons.filter((o) => above(mid(o))), takeAccents.filter((a) => above(a.cy))),
                den: build(takeAtoms.filter((a) => !above(a.cy)), takeCons.filter((o) => !above(mid(o))), takeAccents.filter((a) => !above(a.cy))),
            });
        } else {
            nodes.push({ kind: 'rad', x: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, body: build(takeAtoms, takeCons, takeAccents) });
        }
    }
    return row([...pool, ...nodes], accents.filter((a) => pool.some((p) => overlaps(a, p))));
}

function overlaps(a, b) {
    return Math.min(a.x1, b.x1) - Math.max(a.x, b.x) > 0.3 * Math.min(a.x1 - a.x, b.x1 - b.x);
}

/**
 * Elements of one row in reading order, with scripts attached to what
 * precedes them, accents to what they sit over and tall fences paired.
 */
function row(elements, accents) {
    const sorted = elements.sort((a, b) => a.x - b.x);
    const texts = sorted.filter((e) => e.kind === 'text');
    const size = texts.length ? mainSize(texts) : 0;
    // The row's baseline: where its full-size text sits, else a fraction's axis.
    const full = texts.filter((t) => t.h >= 0.85 * size && t.h <= 1.3 * size);
    const baseline = full.length ? median(full.map((t) => t.y)) : null;

    const out = [];
    for (const e of sorted) {
        if (e.kind === 'text' && baseline !== null && e.h < 0.85 * size && out.length > 0) {
            const raised = e.y < baseline - 0.2 * size;
            const lowered = e.y > baseline + 0.1 * size;
            if (raised || lowered) {
                const prev = out[out.length - 1];
                const slot = raised ? 'sup' : 'sub';
                if (prev.kind === 'script' && !prev[slot] && Math.abs(prev.scriptX - e.x) < 2) {
                    prev[slot] = [{ ...e, kind: 'text' }];
                } else if (prev.kind === 'script' && prev[slot] && e.x - prev.end < 1.5) {
                    prev[slot].push({ ...e, kind: 'text' });
                    prev.end = e.x1;
                } else {
                    out.push({ kind: 'script', base: out.pop(), [slot]: [{ ...e, kind: 'text' }], scriptX: e.x, end: e.x1 });
                }
                continue;
            }
        }
        out.push(e);
    }

    for (const accent of accents) {
        const i = out.findIndex((e) => e.kind === 'text' && overlaps(accent, e));
        if (i >= 0) out[i] = { kind: 'acc', chr: ARC, base: out[i] };
    }
    return fences(out, size);
}

/** Pairs a stretched opening fence with its closing one around the nodes between. */
function fences(nodes, size) {
    const tall = (n) => n.kind === 'text' && n.h > 1.3 * size;
    for (let i = 0; i < nodes.length; i++) {
        const open = nodes[i];
        const ch = open.kind === 'text' ? open.str.trim() : '';
        if (!tall(open) || !OPEN_FENCES[ch]) continue;
        const j = nodes.findIndex((n, k) => k > i && tall(n) && n.str.trim() === OPEN_FENCES[ch]);
        if (j >= 0) {
            const body = fences(nodes.slice(i + 1, j), size);
            nodes.splice(i, j - i + 1, { kind: 'fence', open: ch, close: OPEN_FENCES[ch], body });
        } else if (ch === '{') {
            // A brace with no partner opens a system: one row per baseline.
            const rows = stack(nodes.slice(i + 1), size);
            nodes.splice(i, nodes.length - i, { kind: 'fence', open: ch, close: '', body: rows.length > 1 ? [{ kind: 'stack', rows }] : rows.flat() });
        }
    }
    return nodes;
}

/** Nodes split into rows by the baseline each sits on, top to bottom. */
function stack(nodes, size) {
    const ref = (n) => n.kind === 'text' ? n.y
        : n.kind === 'frac' ? n.y + 0.27 * size
            : n.kind === 'rad' ? n.y1 - 0.25 * size
                : n.kind === 'script' || n.kind === 'acc' ? ref(n.base)
                    : n.kind === 'fence' ? Math.max(...n.body.map(ref), 0) : 0;
    const rows = [];
    for (const n of nodes) {
        const y = ref(n);
        const r = rows.find((row) => Math.abs(row.y - y) < 0.6 * size);
        if (r) r.nodes.push(n);
        else rows.push({ y, nodes: [n] });
    }
    return rows.sort((a, b) => a.y - b.y).map((r) => r.nodes);
}

function baselineOf(tree, atoms, size) {
    const texts = tree.filter((n) => n.kind === 'text' && n.h >= 0.85 * size && n.h <= 1.3 * size);
    if (texts.length) return median(texts.map((t) => t.y));
    const frac = tree.find((n) => n.kind === 'frac');
    // A lone fraction sits on the math axis, about a quarter em over the baseline.
    if (frac) return frac.y + 0.27 * size;
    return median(atoms.map((a) => a.y));
}

// ─── Office Math ────────────────────────────────────────────────────────────

function omml(nodes, size) {
    return nodes.map((n) => ommlNode(n, size)).join('');
}

function ommlNode(n, size) {
    switch (n.kind) {
        case 'text': return run(n, size);
        case 'frac': return `<m:f><m:num>${omml(n.num, size)}</m:num><m:den>${omml(n.den, size)}</m:den></m:f>`;
        case 'rad': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${omml(n.body, size)}</m:e></m:rad>`;
        case 'script': {
            const e = `<m:e>${ommlNode(n.base, size)}</m:e>`;
            if (n.sub && n.sup) return `<m:sSubSup>${e}<m:sub>${omml(n.sub, size)}</m:sub><m:sup>${omml(n.sup, size)}</m:sup></m:sSubSup>`;
            if (n.sup) return `<m:sSup>${e}<m:sup>${omml(n.sup, size)}</m:sup></m:sSup>`;
            return `<m:sSub>${e}<m:sub>${omml(n.sub, size)}</m:sub></m:sSub>`;
        }
        case 'acc': return `<m:acc><m:accPr><m:chr m:val="${n.chr}"/></m:accPr><m:e>${ommlNode(n.base, size)}</m:e></m:acc>`;
        case 'fence':
            return `<m:d><m:dPr><m:begChr m:val="${escapeHtml(n.open)}"/><m:endChr m:val="${escapeHtml(n.close)}"/></m:dPr><m:e>${omml(n.body, size)}</m:e></m:d>`;
        case 'stack': return `<m:eqArr>${n.rows.map((r) => `<m:e>${omml(r, size)}</m:e>`).join('')}</m:eqArr>`;
        default: return '';
    }
}

/** One glyph run. Upright text that is not a lone letter keeps its upright style. */
function run(n, size) {
    const text = n.str.replace(/\s+/g, ' ');
    if (!text.trim()) return '';
    const upright = !n.italic && /\p{L}/u.test(text);
    const mPr = upright ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : '';
    // Word sizes math from the run's own size, scripts shrinking themselves.
    const sz = Math.round(size * 2);
    return `<m:r>${mPr}<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><m:t>${escapeHtml(text.trim())}</m:t></m:r>`;
}

// ─── Linear text ────────────────────────────────────────────────────────────

function linear(nodes) {
    return nodes.map(linearNode).join('');
}

function linearNode(n) {
    switch (n.kind) {
        case 'text': return n.str.replace(/\s+/g, '');
        case 'frac': return `${group(linear(n.num))}/${group(linear(n.den))}`;
        case 'rad': return `√${group(linear(n.body))}`;
        case 'script': {
            let out = linearNode(n.base);
            if (n.sub) out += script(linear(n.sub), SUBSCRIPT, '_');
            if (n.sup) out += script(linear(n.sup), SUPERSCRIPT, '^');
            return out;
        }
        case 'acc': return `${linearNode(n.base)}${n.chr}`;
        case 'fence': return `${n.open}${linear(n.body)}${n.close}`;
        case 'stack': return n.rows.map(linear).join('; ');
        default: return '';
    }
}

function group(text) {
    return /^[\p{L}\p{N}.,]+$/u.test(text) || /^\(.*\)$/.test(text) ? text : `(${text})`;
}

function script(text, table, mark) {
    const chars = [...text];
    return chars.every((c) => table[c]) ? chars.map((c) => table[c]).join('') : `${mark}${group(text)}`;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] || 0;
}
