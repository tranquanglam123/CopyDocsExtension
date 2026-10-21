/**
 * lib/mtef.js trees to Office Math (OMML), which Word edits natively, and to
 * one line of plain text for the clipboard and .txt. A construct this does
 * not know throws UnsupportedMath, so the caller keeps the original object
 * rather than writing a wrong equation.
 */
import { escapeHtml } from './html.js';

export class UnsupportedMath extends Error {}

/** MathType's own spacing characters, in its private-use area. */
const MT_SPACES = { min: 0xEF00, max: 0xEF0F };

/** Typefaces Word sets italic by default: variables and lower-case Greek. */
const ITALIC_TYPEFACES = new Set([3, 4]);
const VECTOR_TYPEFACE = 7;

const FENCES = {
    0: ['⟨', '⟩'], 1: ['(', ')'], 2: ['{', '}'], 3: ['[', ']'], 4: ['|', '|'],
    5: ['‖', '‖'], 6: ['⌊', '⌋'], 7: ['⌈', '⌉'], 8: ['⟦', '⟧'],
};
const NARY = { 16: '∑', 17: '∏', 18: '∐', 19: '⋃', 20: '⋂' };
const INTEGRALS = { 1: '∫', 2: '∬', 3: '∭' };

/** Accents over a whole slot (templates) or one character (embellishments). */
const TMPL_ACCENTS = { 32: '̃', 33: '̂', 34: '̑' };
const EMBELL_ACCENTS = { 2: '̇', 3: '̈', 4: '⃛', 8: '̃', 9: '̂', 11: '⃗', 12: '⃖', 13: '⃡', 14: '⃑', 15: '⃐', 19: '̑', 20: '̆' };
const EMBELL_PRIMES = { 5: '′', 6: '″', 18: '‴' };
const EMBELL_OVERBAR = 17;

const SUPERSCRIPT = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '−': '⁻', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'o': 'ᵒ', '∘': '°' };
const SUBSCRIPT = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '−': '₋', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };

// ─── OMML ───────────────────────────────────────────────────────────────────

/**
 * @param {{items: object[]}} eq  From parseMtef().
 * @returns {string} One `<m:oMath>` element (the `m` prefix is the caller's).
 */
export function toOmml(eq) {
    return `<m:oMath>${omml(eq.items)}</m:oMath>`;
}

/** A list of nodes; scripts take the fragment before them as their base. */
function omml(items) {
    const frags = [];
    for (const node of items) {
        if (node.type === 'tmpl' && (node.selector === 27 || node.selector === 28 || node.selector === 29)) {
            if (node.variation & 0x01) throw new UnsupportedMath('pre-scripts');
            const base = takeBase(frags);
            const [sub, sup] = slots(node);
            const e = `<m:e>${base}</m:e>`;
            frags.push(xmlFrag(
                node.selector === 27 ? `<m:sSub>${e}<m:sub>${omml(sub.items)}</m:sub></m:sSub>`
                    : node.selector === 28 ? `<m:sSup>${e}<m:sup>${omml(sup.items)}</m:sup></m:sSup>`
                        : `<m:sSubSup>${e}<m:sub>${omml(sub.items)}</m:sub><m:sup>${omml(sup.items)}</m:sup></m:sSubSup>`
            ));
        } else {
            frags.push(...nodeFrags(node));
        }
    }
    return serialise(frags);
}

function nodeFrags(node) {
    switch (node.type) {
        case 'line': return node.isNull ? [] : [xmlFrag(omml(node.items))];
        case 'char': return charFrags(node);
        case 'pile': return [xmlFrag(`<m:eqArr>${node.items.map((l) => `<m:e>${omml(l.items || [l])}</m:e>`).join('')}</m:eqArr>`)];
        case 'matrix': {
            const rows = [];
            for (let r = 0; r < node.rows; r++) {
                const cells = node.items.slice(r * node.cols, (r + 1) * node.cols);
                rows.push(`<m:mr>${cells.map((c) => `<m:e>${omml(c.items || [])}</m:e>`).join('')}</m:mr>`);
            }
            return [xmlFrag(`<m:m>${rows.join('')}</m:m>`)];
        }
        case 'tmpl': return [xmlFrag(tmplOmml(node))];
        default: throw new UnsupportedMath(`node ${node.type}`);
    }
}

function tmplOmml(node) {
    const s = node.selector;
    const v = node.variation;
    const [main, second, third] = slots(node);
    const e = (line) => `<m:e>${omml(line?.items || [])}</m:e>`;

    if (s <= 9) {
        const [left, right] = fenceChars(node);
        return `<m:d><m:dPr><m:begChr m:val="${attr(left)}"/><m:endChr m:val="${attr(right)}"/></m:dPr>${e(main)}</m:d>`;
    }
    switch (s) {
        case 10: // root: radicand, then index
            return v === 1
                ? `<m:rad><m:deg>${omml(second?.items || [])}</m:deg>${e(main)}</m:rad>`
                : `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${e(main)}</m:rad>`;
        case 11: { // fraction: numerator, denominator
            const type = v & 0x02 ? (v & 0x04 ? 'lin' : 'skw') : null;
            const fPr = type ? `<m:fPr><m:type m:val="${type}"/></m:fPr>` : '';
            return `<m:f>${fPr}<m:num>${omml(main?.items || [])}</m:num><m:den>${omml(second?.items || [])}</m:den></m:f>`;
        }
        case 12:
        case 13: { // under/over bar
            const bar = (inner) => `<m:bar><m:barPr><m:pos m:val="${s === 12 ? 'bot' : 'top'}"/></m:barPr><m:e>${inner}</m:e></m:bar>`;
            const once = bar(omml(main?.items || []));
            return v & 0x01 ? bar(once) : once;
        }
        case 15: case 16: case 17: case 18: case 19: case 20: case 21: case 22: { // big operators: main, lower, upper
            const op = node.items.find((n) => n.type === 'char');
            const chr = op ? charText(op) : s === 15 ? INTEGRALS[v & 0x03] || '∫' : NARY[s];
            if (!chr) throw new UnsupportedMath(`operator ${s}`);
            const lower = isEmpty(second);
            const upper = isEmpty(third);
            const pr = `<m:naryPr><m:chr m:val="${attr(chr)}"/><m:limLoc m:val="${v & 0x40 ? 'undOvr' : 'subSup'}"/>` +
                `${lower ? '<m:subHide m:val="1"/>' : ''}${upper ? '<m:supHide m:val="1"/>' : ''}</m:naryPr>`;
            return `<m:nary>${pr}<m:sub>${omml(second?.items || [])}</m:sub><m:sup>${omml(third?.items || [])}</m:sup>${e(main)}</m:nary>`;
        }
        case 23: { // limit: main, lower, upper
            let xml = omml(main?.items || []);
            if (!isEmpty(second)) xml = `<m:limLow><m:e>${xml}</m:e><m:lim>${omml(second.items)}</m:lim></m:limLow>`;
            if (!isEmpty(third)) xml = `<m:limUpp><m:e>${xml}</m:e><m:lim>${omml(third.items)}</m:lim></m:limUpp>`;
            return xml;
        }
        case 14: { // arrow with text: top, bottom
            const chr = v & 0x01 ? '⇄' : v & 0x10 ? '←' : '→';
            let xml = `<m:r><m:t>${chr}</m:t></m:r>`;
            if (!isEmpty(main)) xml = `<m:limUpp><m:e>${xml}</m:e><m:lim>${omml(main.items)}</m:lim></m:limUpp>`;
            if (!isEmpty(second)) xml = `<m:limLow><m:e>${xml}</m:e><m:lim>${omml(second.items)}</m:lim></m:limLow>`;
            return xml;
        }
        case 24:
        case 25: { // horizontal brace/bracket: main, label
            const top = v & 0x01;
            const chr = s === 24 ? (top ? '⏞' : '⏟') : (top ? '⎴' : '⎵');
            let xml = `<m:groupChr><m:groupChrPr><m:chr m:val="${chr}"/><m:pos m:val="${top ? 'top' : 'bot'}"/></m:groupChrPr>${e(main)}</m:groupChr>`;
            if (!isEmpty(second)) {
                const tag = top ? 'limUpp' : 'limLow';
                xml = `<m:${tag}><m:e>${xml}</m:e><m:lim>${omml(second.items)}</m:lim></m:${tag}>`;
            }
            return xml;
        }
        case 31: { // vector arrow over (or under) the slot
            if (v & 0x04) throw new UnsupportedMath('under-vector');
            const chr = (v & 0x03) === 0x03 ? '⃡' : v & 0x01 ? '⃖' : v & 0x08 ? '⃑' : '⃗';
            return accent(chr, omml(main?.items || []));
        }
        case 32: case 33: case 34:
            return accent(TMPL_ACCENTS[s], omml(main?.items || []));
        case 37:
            return `<m:borderBox>${e(main)}</m:borderBox>`;
        default:
            throw new UnsupportedMath(`template ${s}`);
    }
}

function charFrags(node) {
    const text = charText(node);
    let frag = { kind: 'char', text, sty: charStyle(node) };
    const out = [];
    for (const embell of node.embells) {
        if (EMBELL_PRIMES[embell]) {
            out.push({ kind: 'char', text: EMBELL_PRIMES[embell], sty: 'p' });
        } else if (EMBELL_ACCENTS[embell]) {
            frag = xmlFrag(accent(EMBELL_ACCENTS[embell], serialise([frag])));
        } else if (embell === EMBELL_OVERBAR) {
            frag = xmlFrag(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${serialise([frag])}</m:e></m:bar>`);
        } else {
            throw new UnsupportedMath(`embellishment ${embell}`);
        }
    }
    return [frag, ...out];
}

/**
 * The script's base: the last fragment, or a whole parenthesised group when
 * that fragment closes one, as MathType's own translators scan for.
 */
function takeBase(frags) {
    if (frags.length === 0) return '';
    const last = frags[frags.length - 1];
    const close = { ')': '(', ']': '[', '}': '{' }[last.kind === 'char' ? last.text : ''];
    if (close) {
        let depth = 0;
        for (let i = frags.length - 1; i >= 0; i--) {
            const t = frags[i].kind === 'char' ? frags[i].text : '';
            if (t === last.text) depth++;
            else if (t === close && --depth === 0) return serialise(frags.splice(i));
        }
    }
    return serialise(frags.splice(frags.length - 1));
}

function accent(chr, inner) {
    return `<m:acc><m:accPr><m:chr m:val="${chr}"/></m:accPr><m:e>${inner}</m:e></m:acc>`;
}

function xmlFrag(xml) {
    return { kind: 'xml', xml };
}

/** Neighbouring characters of one style share a run. */
function serialise(frags) {
    let out = '';
    let run = null;
    const flush = () => {
        if (!run) return;
        const rPr = run.sty ? `<m:rPr><m:sty m:val="${run.sty}"/></m:rPr>` : '';
        out += `<m:r>${rPr}<m:t xml:space="preserve">${escapeXml(run.text)}</m:t></m:r>`;
        run = null;
    };
    for (const f of frags) {
        if (f.kind === 'char') {
            if (run && run.sty === f.sty) run.text += f.text;
            else { flush(); run = { text: f.text, sty: f.sty }; }
        } else {
            flush();
            out += f.xml;
        }
    }
    flush();
    return out;
}

function charStyle(node) {
    if (node.typeface === VECTOR_TYPEFACE) return 'b';
    if (ITALIC_TYPEFACES.has(node.typeface) && /\p{L}/u.test(charText(node))) return null;
    return 'p';
}

// ─── Linear text ────────────────────────────────────────────────────────────

/**
 * Readable on one line, e.g. `(x−1)/y`, `x²`, `√(x+1)`.
 * @param {{items: object[]}} eq
 * @returns {string}
 */
export function toLinear(eq) {
    return linear(eq.items).trim();
}

function linear(items) {
    let out = '';
    for (const node of items) out += linearNode(node);
    return out;
}

function linearNode(node) {
    switch (node.type) {
        case 'line': return node.isNull ? '' : linear(node.items);
        case 'char': {
            let text = charText(node);
            for (const embell of node.embells) {
                if (EMBELL_PRIMES[embell]) text += EMBELL_PRIMES[embell];
                else if (EMBELL_ACCENTS[embell]) text += EMBELL_ACCENTS[embell];
                else if (embell === EMBELL_OVERBAR) text += '̅';
            }
            return text;
        }
        case 'pile': return node.items.map((l) => linear(l.items || [l])).join('; ');
        case 'matrix': {
            const rows = [];
            for (let r = 0; r < node.rows; r++) {
                rows.push(node.items.slice(r * node.cols, (r + 1) * node.cols).map((c) => linear(c.items || [])).join(', '));
            }
            return `[${rows.join('; ')}]`;
        }
        case 'tmpl': return tmplLinear(node);
        default: return '';
    }
}

function tmplLinear(node) {
    const s = node.selector;
    const v = node.variation;
    const [main, second, third] = slots(node);
    const text = (line) => linear(line?.items || []);

    if (s <= 9) {
        const [left, right] = fenceChars(node);
        return `${left}${text(main)}${right}`;
    }
    switch (s) {
        case 10: {
            const radicand = group(text(main), true);
            if (v !== 1) return `√${radicand}`;
            const index = text(second);
            return (index === '3' ? '∛' : index === '4' ? '∜' : `${script(index, SUPERSCRIPT, '')}√`) + radicand;
        }
        case 11: return `${group(text(main))}/${group(text(second))}`;
        case 12: case 13: return combineEach(text(main), s === 12 ? '̲' : '̅');
        case 27: return script(text(main), SUBSCRIPT, '_');
        case 28: return script(text(second), SUPERSCRIPT, '^');
        case 29: return script(text(main), SUBSCRIPT, '_') + script(text(second), SUPERSCRIPT, '^');
        case 15: case 16: case 17: case 18: case 19: case 20: case 21: case 22: {
            const op = node.items.find((n) => n.type === 'char');
            const chr = op ? charText(op) : s === 15 ? INTEGRALS[v & 0x03] || '∫' : NARY[s] || '';
            const lower = isEmpty(second) ? '' : `_${group(text(second))}`;
            const upper = isEmpty(third) ? '' : `^${group(text(third))}`;
            return `${chr}${lower}${upper} ${text(main)}`;
        }
        case 23: return `${text(main)}${isEmpty(second) ? '' : `_(${text(second)})`}`;
        case 14: return `${isEmpty(main) ? '' : `(${text(main)})`}${v & 0x10 ? '←' : '→'}`;
        case 31: return combineEach(text(main), '⃗');
        case 32: case 33: case 34: return combineEach(text(main), TMPL_ACCENTS[s]);
        default: return text(main);
    }
}

/** Unicode super/subscript glyphs when every character has one. */
function script(text, table, marker) {
    if (!text) return '';
    const chars = [...text];
    if (chars.every((c) => table[c])) return chars.map((c) => table[c]).join('');
    return `${marker}${group(text)}`;
}

/** Parentheses, unless the text is one symbol or already one group. */
function group(text, always = false) {
    if (!always && (/^[\p{L}\p{N}.,]+$/u.test(text) && [...text].length <= 1 || /^\p{N}+([.,]\p{N}+)?$/u.test(text))) return text;
    if (/^\(.*\)$/.test(text) && balanced(text.slice(1, -1))) return text;
    return `(${text})`;
}

function balanced(text) {
    let depth = 0;
    for (const c of text) {
        if (c === '(') depth++;
        else if (c === ')' && --depth < 0) return false;
    }
    return depth === 0;
}

function combineEach(text, mark) {
    return [...text].map((c) => (/\s/.test(c) ? c : c + mark)).join('');
}

// ─── Shared ─────────────────────────────────────────────────────────────────

/** A template's line/pile subobjects, in their slot order. */
function slots(node) {
    return node.items.filter((n) => n.type === 'line' || n.type === 'pile')
        .map((n) => (n.type === 'pile' ? { type: 'line', items: [n] } : n));
}

function fenceChars(node) {
    const chars = node.items.filter((n) => n.type === 'char').map(charText);
    if (node.selector === 9) return [chars[0] || '', chars[1] || ''];
    const [defLeft, defRight] = FENCES[node.selector];
    const hasLeft = node.variation & 0x01;
    const hasRight = node.variation & 0x02;
    // A fence present on both sides lists both characters; one side lists one.
    const left = hasLeft ? (chars.shift() || defLeft) : '';
    const right = hasRight ? (chars.shift() || defRight) : '';
    return [left, right];
}

function isEmpty(line) {
    return !line || line.isNull || (line.items || []).length === 0;
}

function charText(node) {
    const code = node.code;
    if (code >= MT_SPACES.min && code <= MT_SPACES.max) return ' ';
    if (!code || (code >= 0xE000 && code <= 0xF8FF)) throw new UnsupportedMath(`character 0x${(code || 0).toString(16)}`);
    return String.fromCodePoint(code);
}

function attr(text) {
    return escapeHtml(text);
}

function escapeXml(text) {
    return escapeHtml(text).replace(/'/g, '&apos;');
}
