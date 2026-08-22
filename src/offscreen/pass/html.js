import { StyleDecision } from '../../lib/emphasis.js';
import { StyleFill } from '../../lib/style.js';
import { WARNINGS, STYLE_FILL_MAX_BYTES } from '../../lib/const.js';

/** Kept in cleaned HTML — everything else is unwrapped, children kept. */
const ALLOWED_TAGS = new Set([
    'P', 'BR', 'HR',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE',
    'SUP', 'SUB',
    'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
    'COLGROUP', 'COL',
    'A',
    'BLOCKQUOTE', 'PRE', 'CODE',
    'SPAN', 'DIV',
    'IMG',
]);

const BLOCK_CHILD_TAGS = ['DIV', 'P', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

/**
 * Three passes over the same element list: read every formatting decision
 * while the class-driven cascade is intact, then mutate structure, then write
 * the style attributes. Reading after any mutation risks a cascade that no
 * longer matches what was rendered.
 *
 * @param {Document} idoc
 * @param {Window} iwin
 * @param {Element} container
 * @returns {{html: string, warnings: string[]}}
 */
export function extractBodyHtml(idoc, iwin, container) {
    const allEls = [...container.querySelectorAll('*')];

    // ── Pass 1: read authored + computed style ─────────────────────────
    // Most elements are visited twice — once as "self", once as a sibling's
    // "parent" — so cache the computed read.
    const appearanceCache = new Map();
    const computeAppearance = (el, cs) => {
        const styleDecl = cs || iwin.getComputedStyle(el);
        const obj = {};
        for (const prop of StyleFill.APPEARANCE_PROPERTIES) {
            obj[prop] = styleDecl.getPropertyValue(prop);
        }
        return obj;
    };
    const getAppearance = (el) => {
        if (!appearanceCache.has(el)) {
            appearanceCache.set(el, computeAppearance(el));
        }
        return appearanceCache.get(el);
    };

    const decisions = new Map();
    for (const el of allEls) {
        const cs = iwin.getComputedStyle(el);
        const flags = StyleDecision.styleFlags({
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            textDecorationLine: cs.textDecorationLine || cs.textDecoration,
        });
        // A span may be bold AND italic AND underlined — nest, never collapse.
        const formatTags = [];
        if (flags.bold) formatTags.push('b');
        if (flags.italic) formatTags.push('i');
        if (flags.underline) formatTags.push('u');

        const ownAppearance = computeAppearance(el, cs);
        appearanceCache.set(el, ownAppearance);
        const parentAppearance = getAppearance(el.parentElement || container);

        decisions.set(el, {
            formatTags,
            authoredStyleText: el.getAttribute('style') || '',
            ownAppearance,
            parentAppearance,
        });
    }

    // Every decision is captured — the cascade's source can go.
    container.querySelectorAll('style, script, noscript').forEach((el) => el.remove());

    // ── Pass 2: mutate structure ───────────────────────────────────────
    // Keys are the SURVIVING elements, which may be replacements.
    const styleTargets = new Map();

    for (const el of allEls) {
        if (!el.isConnected) continue; // already excised

        if ((el.tagName === 'SPAN' || el.tagName === 'DIV') && !el.hasChildNodes()) {
            el.remove();
            continue;
        }

        const decision = decisions.get(el) || { formatTags: [], authoredStyleText: '', ownAppearance: {}, parentAppearance: {} };

        // Children are MOVED, never reparsed through innerHTML, so nodes
        // nested inside keep their identity and their own decision.
        if (el.tagName === 'SPAN' && decision.formatTags.length > 0) {
            let outermost = null;
            let innermost = null;
            for (const tag of decision.formatTags) {
                const node = idoc.createElement(tag);
                if (innermost) innermost.appendChild(node);
                innermost = node;
                if (!outermost) outermost = node;
            }
            while (el.firstChild) innermost.appendChild(el.firstChild);
            el.replaceWith(outermost);
            styleTargets.set(outermost, decision);
            continue;
        }

        el.removeAttribute('class');
        el.removeAttribute('id');
        el.removeAttribute('data-aria-level');
        el.removeAttribute('data-aria-posinset');
        el.removeAttribute('role');
        el.removeAttribute('dir');
        // `style` is left alone — Pass 3 owns it and may run twice.

        if (!ALLOWED_TAGS.has(el.tagName)) {
            const frag = idoc.createDocumentFragment();
            while (el.firstChild) frag.appendChild(el.firstChild);
            el.replaceWith(frag);
            continue;
        }

        styleTargets.set(el, decision);
    }

    // mobilebasic uses <div> for paragraphs.
    container.querySelectorAll('div').forEach((div) => {
        const hasBlockChild = [...div.children].some((c) => BLOCK_CHILD_TAGS.includes(c.tagName));
        if (!hasBlockChild && div.textContent.trim()) {
            const p = idoc.createElement('p');
            while (div.firstChild) p.appendChild(div.firstChild);
            div.replaceWith(p);
            if (styleTargets.has(div)) {
                styleTargets.set(p, styleTargets.get(div));
                styleTargets.delete(div);
            }
        }
    });

    // ── Pass 3: write style attributes ─────────────────────────────────
    const applyStyles = (includeComputedFill) => {
        for (const [element, decision] of styleTargets) {
            const styleObj = StyleFill.buildElementStyle({
                authoredStyleText: decision.authoredStyleText,
                computed: includeComputedFill ? decision.ownAppearance : undefined,
                parentComputed: includeComputedFill ? decision.parentAppearance : undefined,
            });
            const styleText = StyleFill.serializeStyle(styleObj);
            if (styleText) {
                element.setAttribute('style', styleText);
            } else {
                element.removeAttribute('style');
            }
        }
    };

    applyStyles(true);
    let html = container.innerHTML || '';
    const warnings = [];

    const sizeBytes = new TextEncoder().encode(html).length;
    if (sizeBytes > STYLE_FILL_MAX_BYTES) {
        // Never truncate — drop the computed fill and say so.
        applyStyles(false);
        html = container.innerHTML || '';
        warnings.push(WARNINGS.STYLE_FILL_SKIPPED_SIZE);
    }

    return { html, warnings };
}
