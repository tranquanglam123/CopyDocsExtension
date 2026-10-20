/**
 * PDF text items to paragraphs. A PDF stores positioned glyph runs, not
 * paragraphs, so lines are rebuilt from baselines and paragraphs from gaps
 * and margins. offscreen/file/pdf.js measures; this only does geometry.
 */
import { escapeHtml } from './html.js';

/**
 * Starts a new paragraph even when the line above ran to the margin: exam
 * questions, answer choices and list items in Vietnamese teaching material.
 */
const BLOCK_START = /^(Câu|Bài|Phần|PHẦN|Ví dụ|Lời giải|Hướng dẫn|Đáp án|[A-Da-d][.)]|\d{1,3}[.)]|[IVX]{1,5}[.)]|[-–•+*●▪])\s/;

const EM_SPACE = ' ';

/**
 * @typedef {{str: string, x: number, y: number, w: number, h: number, bold?: boolean, italic?: boolean}} TextItem
 *   `y` is the baseline measured from the top of the page; `h` the font size.
 * @typedef {{y: number, html: string}} PageImage   A block placed by its top edge.
 * @typedef {{items: TextItem[], images?: PageImage[]}} PageLayout
 */

/**
 * @param {PageLayout[]} pages
 * @returns {{bodyHtml: string, text: string}}
 */
export function layoutPages(pages) {
    const html = [];
    const text = [];

    for (const page of pages || []) {
        const blocks = [
            ...paragraphsOf(page.items || []).map((p) => ({ y: p.y, html: p.html, text: p.text })),
            ...(page.images || []).map((img) => ({ y: img.y, html: img.html, text: '' })),
        ].sort((a, b) => a.y - b.y);

        for (const block of blocks) {
            html.push(block.html);
            if (block.text) text.push(block.text);
        }
    }

    return { bodyHtml: html.join('\n'), text: text.join('\n\n') };
}

/**
 * @param {TextItem[]} items
 * @returns {Array<{y: number, html: string, text: string}>}
 */
export function paragraphsOf(items) {
    const lines = buildLines(items);
    if (lines.length === 0) return [];

    const bodySize = median(lines.map((l) => l.size));
    const left = Math.min(...lines.map((l) => l.left));
    const right = Math.max(...lines.map((l) => l.right));
    const width = Math.max(1, right - left);

    const paragraphs = [];
    let current = null;

    for (const line of lines) {
        if (current && continues(current.last, line, left, width)) {
            current.lines.push(line);
            current.last = line;
        } else {
            current = { lines: [line], last: line };
            paragraphs.push(current);
        }
    }

    return paragraphs.map((p) => render(p.lines, { bodySize, left, width }));
}

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
        const line = lines[lines.length - 1];
        if (line && Math.abs(item.y - line.y) <= 0.5 * Math.max(line.size, item.h)) {
            line.items.push(item);
            if (item.h > line.size) { line.size = item.h; line.y = item.y; }
        } else {
            lines.push({ y: item.y, size: item.h, items: [item] });
        }
    }

    for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        line.left = line.items[0].x;
        line.right = Math.max(...line.items.map((it) => it.x + it.w));
        line.runs = runsOf(line);
        line.plain = line.runs.map((r) => r.text).join('');
    }
    return lines;
}

/** Wrapped text reaches the right margin; anything shorter ended its paragraph. */
function continues(prev, line, left, width) {
    if (line.y - prev.y > 1.8 * prev.size) return false;
    if (Math.abs(line.size - prev.size) > 0.15 * prev.size) return false;
    if (prev.right < left + 0.85 * width) return false;
    if (line.left > prev.left + 1.5 * line.size) return false;
    if (BLOCK_START.test(line.plain)) return false;
    return true;
}

function runsOf(line) {
    const runs = [];
    let prev = null;

    for (const item of line.items) {
        const script = item.h < 0.85 * line.size && item.y < line.y - 0.15 * line.size ? 'sup'
            : item.h < 0.85 * line.size && item.y > line.y + 0.1 * line.size ? 'sub'
                : null;

        let str = item.str;
        if (prev) {
            const gap = item.x - (prev.x + prev.w);
            const touching = /\s$/.test(prev.str) || /^\s/.test(str);
            if (gap > 2.5 * line.size) str = EM_SPACE + str.trimStart();
            else if (gap > 0.15 * line.size && !touching) str = ' ' + str;
        }

        const style = { bold: !!item.bold, italic: !!item.italic, script };
        const last = runs[runs.length - 1];
        if (last && last.bold === style.bold && last.italic === style.italic && last.script === style.script) {
            last.text += str;
        } else {
            runs.push({ text: str, ...style });
        }
        prev = item;
    }
    return runs;
}

function render(lines, { bodySize, left, width }) {
    const runs = [];
    lines.forEach((line, i) => {
        if (i > 0) runs.push({ text: ' ', bold: false, italic: false, script: null });
        runs.push(...line.runs);
    });

    const first = lines[0];
    const size = first.size;
    const tag = size >= 1.5 * bodySize ? 'h1' : size >= 1.2 * bodySize ? 'h2' : 'p';

    // A short line sitting on the text block's centre line, not its margin.
    const lineWidth = first.right - first.left;
    const centred = lines.length === 1 &&
        first.left > left + 2 * size &&
        lineWidth < 0.8 * width &&
        Math.abs((first.left + first.right) / 2 - (left + width / 2)) < 0.06 * width;

    const inner = runs.map(runHtml).join('').trim();
    const attr = centred ? ' style="text-align:center"' : '';
    return {
        y: first.y - first.size,
        html: `<${tag}${attr}>${inner}</${tag}>`,
        text: runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim(),
    };
}

function runHtml(run) {
    let html = escapeHtml(run.text);
    if (run.script) html = `<${run.script}>${html}</${run.script}>`;
    if (run.italic) html = `<i>${html}</i>`;
    if (run.bold) html = `<b>${html}</b>`;
    return html;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] || 0;
}
