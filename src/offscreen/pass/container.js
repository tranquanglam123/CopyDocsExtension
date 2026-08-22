import { ContainerScore } from '../../lib/score.js';

/** Fast-path container selectors, ordered by specificity. */
const CONTAINER_SELECTORS = [
    'div.doc-content',
    '#contents',
    '[role="main"]',
    'div.doc',
    'table.waffle',
    '.grid-container',
    '.punch-viewer-content',
    '.slide-content',
];

/** Google UI chrome — never real document content. */
const NOISE_SELECTORS = [
    'nav', 'header', 'footer',
    '[role="navigation"]',
    '[role="banner"]',
    // Matches `gb_xyz`, not just the literal class `gb_`.
    '[class^="gb_"]', '[class*=" gb_"]', '#gb',
    '.docs-butterbar',
    '.docs-companion',
    '.mobile-topbar',
    '.docs-ml-header',
    '#docs-header',
];

/** Tags scored as structural-fallback candidates. */
const CANDIDATE_TAGS = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'TD'];

/** Below this, a selector hit is not trusted and scoring runs instead. */
const MIN_ACCEPTABLE_TEXT_LENGTH = 40;

/**
 * Known selectors first, structural scoring second. The fallback never needs
 * a class name — that is what survives Google renaming things.
 * @param {Document} idoc
 * @returns {{element: Element, method: string}}
 */
export function findContainer(idoc) {
    for (const selector of CONTAINER_SELECTORS) {
        let el = null;
        try {
            el = idoc.querySelector(selector);
        } catch {
            el = null;
        }
        if (el && el.tagName !== 'BODY' &&
            (el.textContent || '').trim().length >= MIN_ACCEPTABLE_TEXT_LENGTH) {
            return { element: el, method: `selector:${selector}` };
        }
    }

    const best = scoreCandidates(idoc);
    if (best) {
        return { element: best.candidate.ref, method: 'structural-score' };
    }

    return { element: idoc.body, method: 'body-fallback' };
}

/**
 * DOM-walking wrapper — all scoring math lives in lib/score.js.
 * @param {Document} idoc
 * @returns {{candidate: object, score: number}|null}
 */
function scoreCandidates(idoc) {
    if (!idoc.body) return null;

    const candidates = [];
    const elements = idoc.body.querySelectorAll(CANDIDATE_TAGS.join(','));

    for (const el of elements) {
        // Exclude nav/header/footer/aside AND anything nested inside them.
        if (el.closest('nav, header, footer, aside')) continue;

        const textLength = (el.textContent || '').length;
        if (textLength < MIN_ACCEPTABLE_TEXT_LENGTH) continue;

        candidates.push({
            tagName: el.tagName,
            textLength,
            linkTextLength: measureLinkTextLength(el),
            paragraphCount: el.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6').length,
            ref: el,
        });
    }

    // <body> is always eligible so scoring never comes back empty when there
    // IS content on the page.
    candidates.push({
        tagName: 'BODY',
        textLength: (idoc.body.textContent || '').length,
        linkTextLength: measureLinkTextLength(idoc.body),
        paragraphCount: idoc.body.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6').length,
        ref: idoc.body,
    });

    return ContainerScore.pickBest(candidates);
}

/** @param {Element} el @returns {number} */
function measureLinkTextLength(el) {
    let total = 0;
    el.querySelectorAll('a').forEach((a) => { total += (a.textContent || '').length; });
    return total;
}

/** @param {Element} container */
export function removeNoise(container) {
    for (const selector of NOISE_SELECTORS) {
        container.querySelectorAll(selector).forEach((el) => el.remove());
    }
}
