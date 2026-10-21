/**
 * Ruled tables from a PDF page's rules. Word and most generators draw each
 * cell edge as a thin filled rectangle or a stroked line; edges that meet
 * form a grid, and where an inner edge is missing two grid cells are one
 * merged cell.
 */

/** Grid lines closer than this (points) are one line. */
const SNAP = 1.5;

/** Thicker than this, a filled rectangle is shading, not a rule. */
const RULE_MAX = 2.5;

/** An edge counts as drawn when rules cover this share of it. */
const COVERED = 0.6;

/**
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Box
 * @typedef {{dir: 'h'|'v', at: number, from: number, to: number, width: number}} Rule
 * @typedef {{row: number, col: number, rows: number, cols: number, x0: number, y0: number, x1: number, y1: number,
 *   borders: {top: number, right: number, bottom: number, left: number}, fill: string|null}} Cell
 *   `borders` are rule widths in points, 0 where the side is not drawn.
 * @typedef {{x0: number, y0: number, x1: number, y1: number, xs: number[], ys: number[], cells: Cell[]}} Table
 */

/**
 * The rules among a page's shapes: thin axis-aligned rectangles, and the
 * axis-aligned segments of stroked paths.
 * @param {Array<Box & {points?: number[][], fill?: string|null, stroke?: boolean, lineWidth?: number, closed?: boolean, curved?: boolean}>} shapes
 * @returns {Rule[]}
 */
export function rulesOf(shapes) {
    const rules = [];
    for (const s of shapes) {
        if (s.curved) continue;
        const w = s.x1 - s.x0;
        const h = s.y1 - s.y0;
        if (s.fill && isRect(s)) {
            if (h <= RULE_MAX && w > h && w >= 2) rules.push({ dir: 'h', at: (s.y0 + s.y1) / 2, from: s.x0, to: s.x1, width: Math.max(h, 0.25) });
            else if (w <= RULE_MAX && h > w && h >= 2) rules.push({ dir: 'v', at: (s.x0 + s.x1) / 2, from: s.y0, to: s.y1, width: Math.max(w, 0.25) });
            continue;
        }
        if (!s.stroke || !s.points) continue;
        const pts = s.closed ? [...s.points, s.points[0]] : s.points;
        for (let i = 1; i < pts.length; i++) {
            const [ax, ay] = pts[i - 1];
            const [bx, by] = pts[i];
            const width = Math.max(s.lineWidth || 0, 0.25);
            if (Math.abs(ay - by) < 0.3 && Math.abs(ax - bx) >= 2) rules.push({ dir: 'h', at: (ay + by) / 2, from: Math.min(ax, bx), to: Math.max(ax, bx), width });
            else if (Math.abs(ax - bx) < 0.3 && Math.abs(ay - by) >= 2) rules.push({ dir: 'v', at: (ax + bx) / 2, from: Math.min(ay, by), to: Math.max(ay, by), width });
        }
    }
    return rules;
}

/** A closed four-cornered path with axis-aligned sides. */
function isRect(s) {
    if (!s.points) return true;
    const pts = s.points.length > 4 && near(s.points[0], s.points[s.points.length - 1]) ? s.points.slice(0, -1) : s.points;
    if (pts.length !== 4) return false;
    return pts.every(([x, y]) => (Math.abs(x - s.x0) < 0.3 || Math.abs(x - s.x1) < 0.3) && (Math.abs(y - s.y0) < 0.3 || Math.abs(y - s.y1) < 0.3));
}

function near(a, b) {
    return Math.abs(a[0] - b[0]) < 0.3 && Math.abs(a[1] - b[1]) < 0.3;
}

/**
 * Tables from rules: each set of crossing rules with at least two lines
 * each way, as a grid of cells.
 * @param {Rule[]} rules
 * @param {Array<Box & {fill?: string|null}>} [fills]  Filled areas, for cell shading.
 * @returns {{tables: Table[], used: Set<Rule>}}  `used`: the rules the tables drew.
 */
export function findTables(rules, fills = []) {
    const tables = [];
    const used = new Set();
    for (const group of connected(rules)) {
        const h = group.filter((r) => r.dir === 'h');
        const v = group.filter((r) => r.dir === 'v');
        if (h.length < 2 || v.length < 2) continue;
        const table = grid(h, v, fills);
        if (!table) continue;
        tables.push(table);
        for (const r of group) used.add(r);
    }
    return { tables, used };
}

/** Rules that cross or touch, as groups. */
function connected(rules) {
    const parent = rules.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const touches = (a, b) => {
        if (a.dir === b.dir) {
            return Math.abs(a.at - b.at) <= SNAP && a.from <= b.to + SNAP && b.from <= a.to + SNAP;
        }
        const [hr, vr] = a.dir === 'h' ? [a, b] : [b, a];
        return vr.at >= hr.from - SNAP && vr.at <= hr.to + SNAP && hr.at >= vr.from - SNAP && hr.at <= vr.to + SNAP;
    };
    // Sorted sweeps keep this near-linear on a page of a few hundred rules.
    const order = rules.map((r, i) => i).sort((a, b) => lo(rules[a]) - lo(rules[b]));
    for (let k = 0; k < order.length; k++) {
        const a = rules[order[k]];
        for (let m = k + 1; m < order.length; m++) {
            const b = rules[order[m]];
            if (lo(b) > hi(a) + SNAP) break;
            if (touches(a, b)) parent[find(order[k])] = find(order[m]);
        }
    }
    const groups = new Map();
    rules.forEach((r, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(r);
    });
    return [...groups.values()];
}

/** A rule's extent on the x axis, for the sweep. */
function lo(r) {
    return r.dir === 'h' ? r.from : r.at - r.width;
}

function hi(r) {
    return r.dir === 'h' ? r.to : r.at + r.width;
}

/** Positions within SNAP of each other, as one. */
function snap(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const out = [];
    for (const v of sorted) {
        if (out.length && v - out[out.length - 1].last <= SNAP) {
            const c = out[out.length - 1];
            c.last = v;
            c.sum += v;
            c.n++;
        } else out.push({ last: v, sum: v, n: 1 });
    }
    return out.map((c) => c.sum / c.n);
}

function grid(h, v, fills) {
    const ys = snap(h.map((r) => r.at));
    const xs = snap(v.map((r) => r.at));
    if (xs.length < 2 || ys.length < 2) return null;
    const rows = ys.length - 1;
    const cols = xs.length - 1;

    const covered = (rules, at, from, to) => {
        let sum = 0;
        let width = 0;
        for (const r of rules) {
            if (Math.abs(r.at - at) > SNAP) continue;
            const overlap = Math.min(r.to, to) - Math.max(r.from, from);
            if (overlap > 0) {
                sum += overlap;
                width = Math.max(width, r.width);
            }
        }
        return sum >= COVERED * (to - from) ? width : 0;
    };
    // vEdge[r][k]: the rule at xs[k] beside row r; hEdge[k][c]: the rule at ys[k] over column c.
    const vEdge = Array.from({ length: rows }, (_, r) => xs.map((x) => covered(v, x, ys[r], ys[r + 1])));
    const hEdge = ys.map((y) => Array.from({ length: cols }, (_, c) => covered(h, y, xs[c], xs[c + 1])));

    // Flood the grid: a missing inner edge joins its two cells.
    const id = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    const cells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (id[r][c] >= 0) continue;
            let cs = 1;
            while (c + cs < cols && !vEdge[r][c + cs] && id[r][c + cs] < 0) cs++;
            let rs = 1;
            const joins = (row) => Array.from({ length: cs }, (_, k) => !hEdge[row][c + k] && id[row][c + k] < 0 && (k === 0 || !vEdge[row][c + k])).every(Boolean);
            while (r + rs < rows && joins(r + rs)) rs++;
            for (let i = 0; i < rs; i++) for (let k = 0; k < cs; k++) id[r + i][c + k] = cells.length;
            cells.push({ row: r, col: c, rows: rs, cols: cs });
        }
    }
    // A grid with no inner edge at all is a framed box, not a table.
    if (cells.length < 2) return null;

    for (const cell of cells) {
        const { row: r, col: c, rows: rs, cols: cs } = cell;
        Object.assign(cell, { x0: xs[c], x1: xs[c + cs], y0: ys[r], y1: ys[r + rs] });
        cell.borders = {
            top: Math.max(...Array.from({ length: cs }, (_, k) => hEdge[r][c + k])),
            bottom: Math.max(...Array.from({ length: cs }, (_, k) => hEdge[r + rs][c + k])),
            left: Math.max(...Array.from({ length: rs }, (_, i) => vEdge[r + i][c])),
            right: Math.max(...Array.from({ length: rs }, (_, i) => vEdge[r + i][c + cs])),
        };
        const area = (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
        const shade = fills.find((f) => {
            const w = Math.min(f.x1, cell.x1) - Math.max(f.x0, cell.x0);
            const hh = Math.min(f.y1, cell.y1) - Math.max(f.y0, cell.y0);
            return w > 0 && hh > 0 && w * hh >= 0.8 * area;
        });
        cell.fill = shade?.fill || null;
    }
    return { x0: xs[0], y0: ys[0], x1: xs[cols], y1: ys[rows], xs, ys, cells };
}
