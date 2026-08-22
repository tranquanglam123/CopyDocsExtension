/**
 * OffscreenParser — runs inside the chrome.offscreen document
 * (reasons: ['DOM_PARSER']). Receives raw fetched HTML from the service
 * worker and returns the same structured-content shape v1's content-script
 * scan() produced, so lib/docx-generator.js's input contract is untouched.
 *
 * Fixes D2 (content/content-script.js:113-137): mobilebasic's bold/italic/
 * underline are usually CSS *classes* defined in a <style> block
 * (e.g. `.c3{font-weight:700}`), not inline `style="..."`. Reading only
 * `node.style` (as the legacy scanner does) silently drops them. This
 * parser instead:
 *
 *   1. Loads the HTML into a `<iframe sandbox="allow-same-origin">`
 *      (no `allow-scripts` — page scripts can never execute) via `srcdoc`,
 *      so the document's own <style> block participates in a REAL CSS
 *      cascade the browser resolves for us.
 *   2. Reads `getComputedStyle(node)` for every element — the fully
 *      resolved style, class-based or inline, doesn't matter — BEFORE any
 *      class/id stripping happens (stripping first would destroy the very
 *      cascade we need to read).
 *   3. Only after every element's formatting decision has been captured
 *      does it strip `class`/`id` and emit clean HTML.
 *
 * Sanitisation (lib/html-sanitize.js) runs before anything is read at all.
 *
 * Message contract:
 *   request:  { type: 'parse', html: string, docType?: 'docs'|'sheets'|'slides' }
 *   response: { ok: true,  data: { title, text, html, bodyHtml, charCount, meta } }
 *          |  { ok: false, error: string }
 *
 * Lifecycle (owned by the service worker, NOT this file): create the
 * offscreen document with chrome.offscreen.createDocument, send one 'parse'
 * message, then close the document (or let it idle out) — see the wiring
 * notes handed back to the orchestrator.
 */

import { HtmlSanitize } from '../lib/sanitize.js';
import { StyleDecision } from '../lib/emphasis.js';
import { ContainerScore } from '../lib/score.js';
import { StyleFill } from '../lib/style.js';
import { wrapAsDocument } from '../lib/html.js';
import { WARNINGS, TIMING, STYLE_FILL_MAX_BYTES } from '../lib/const.js';

class OffscreenParser {

    // ─── Config (reused from the legacy DOMScanner — "the good parts") ────

    /** Fast-path container selectors, ordered by specificity (spec §4.3 step 1). */
    static CONTAINER_SELECTORS = [
        'div.doc-content',
        '#contents',
        '[role="main"]',
        'div.doc',
        'table.waffle',
        '.grid-container',
        '.punch-viewer-content',
        '.slide-content',
    ];

    /** Elements that are Google UI chrome — never real document content. */
    static NOISE_SELECTORS = [
        'nav', 'header', 'footer',
        '[role="navigation"]',
        '[role="banner"]',
        // Broadened vs. the legacy `.gb_` (D6-class fix): matches `gb_xyz`, not just the literal class `gb_`.
        '[class^="gb_"]', '[class*=" gb_"]', '#gb',
        '.docs-butterbar',
        '.docs-companion',
        '.mobile-topbar',
        '.docs-ml-header',
        '#docs-header',
    ];

    /** Tags to keep in cleaned HTML — everything else is unwrapped (children kept). */
    static ALLOWED_TAGS = new Set([
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

    /** Element tags scored as structural-fallback container candidates (spec §4.3 step 2). */
    static CANDIDATE_TAGS = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'TD'];

    /**
     * Minimum text length for the fast-path selector match to be trusted
     * outright. This is a local, minimal stand-in for the real quality gate
     * (lib/quality-gate.js, arriving in P3) — it exists only so a selector
     * hit that resolves to an empty/near-empty element doesn't short-circuit
     * the structural fallback below it.
     */
    static MIN_ACCEPTABLE_TEXT_LENGTH = 40;

    /** Max time to wait for the sandboxed iframe to finish loading srcdoc. */
    static LOAD_TIMEOUT_MS = TIMING.SANDBOX_LOAD_TIMEOUT_MS;

    /**
     * Fixed width the sandbox iframe is set to before any `getComputedStyle`
     * read (spec §3.2 last line). Geometry is never taken from computed
     * style (see `StyleFill` — layout is authored-only), but this still
     * keeps any computed value that *does* leak through sane rather than
     * reflecting the iframe's default near-zero width.
     */
    static SANDBOX_WIDTH_PX = 1000;

    /**
     * Size budget for `bodyHtml` (spec §3.6). Inlining authored + computed
     * styles onto ~3 400 elements grows the output; past this, the
     * computed-fill pass is dropped (authored styles only kept) rather than
     * silently truncating anything.
     */
    static STYLE_FILL_SIZE_BUDGET_BYTES = STYLE_FILL_MAX_BYTES;

    // ─── Entry point ────────────────────────────────────────────────────

    /**
     * Parse raw HTML into the structured-content contract.
     * @param {string} html
     * @param {string} [docType]
     * @returns {Promise<{title:string, text:string, html:string, bodyHtml:string, charCount:number, meta:object}>}
     */
    static async parseHtml(html, docType) {
        if (typeof html !== 'string' || !html) {
            throw new Error('OffscreenParser.parseHtml requires a non-empty HTML string.');
        }

        const iframe = OffscreenParser._createSandbox();
        document.body.appendChild(iframe);

        try {
            await OffscreenParser._loadSrcdoc(iframe, html);

            const idoc = iframe.contentDocument;
            const iwin = iframe.contentWindow;
            if (!idoc || !iwin) {
                throw new Error('Could not access the sandboxed iframe document (allow-same-origin missing?).');
            }

            // Sanitise BEFORE reading anything (spec §4.2 step 5). Does not
            // touch <style>/class, so the cascade needed below is intact.
            HtmlSanitize.sanitize(idoc);

            const { element: container, method } = OffscreenParser._findContainer(idoc);
            OffscreenParser._removeNoise(container);

            const title = OffscreenParser._extractTitle(idoc, container);
            const text = OffscreenParser._extractPlainText(idoc, container);
            const { html: bodyHtml, warnings: styleWarnings } = OffscreenParser._extractBodyHtml(idoc, iwin, container);
            const fullHtml = wrapAsDocument(bodyHtml, title);
            const charCount = text.length;

            const warnings = [...styleWarnings];
            if (charCount === 0) warnings.push(WARNINGS.EMPTY_CONTENT);
            if (method === 'structural-score') warnings.push(WARNINGS.CONTAINER_FALLBACK_USED);
            if (method === 'body-fallback') warnings.push(WARNINGS.CONTAINER_NOT_FOUND);

            return {
                title,
                text,
                html: fullHtml,
                bodyHtml,
                charCount,
                meta: {
                    // strategyId/transport/tabsFound/tabsExtracted/sheetsFound/
                    // sheetsExtracted/score are populated by the caller (the
                    // strategy engine, P3) which has that context; this parser
                    // only fills what it can determine from the HTML itself.
                    strategyId: docType || null,
                    transport: null,
                    tabsFound: 1,
                    tabsExtracted: 1,
                    sheetsFound: docType === 'sheets' ? 1 : null,
                    sheetsExtracted: docType === 'sheets' ? 1 : null,
                    score: null,
                    warnings,
                },
            };
        } finally {
            iframe.remove();
        }
    }

    // ─── Sandbox iframe ─────────────────────────────────────────────────

    /**
     * Build the sandboxed iframe used to parse untrusted HTML.
     * `allow-same-origin` WITHOUT `allow-scripts` is the deliberate,
     * spec-required combination: it lets us read the loaded document's DOM
     * synchronously, while guaranteeing any <script> in the fetched HTML
     * (and any that survives sanitisation) can never execute.
     *
     * Width is fixed at `SANDBOX_WIDTH_PX` (spec §3.2) rather than left at
     * `0` — layout properties are never read from computed style (they are
     * authored-only, see `StyleFill`), but a sane width keeps any computed
     * value that does leak through from reflecting the iframe's near-zero
     * default box.
     * @returns {HTMLIFrameElement}
     */
    static _createSandbox() {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-same-origin');
        iframe.style.cssText = `position:absolute; width:${OffscreenParser.SANDBOX_WIDTH_PX}px; height:0; border:0; visibility:hidden;`;
        return iframe;
    }

    /**
     * Load HTML into the iframe via `srcdoc` and wait for it to finish.
     * @param {HTMLIFrameElement} iframe
     * @param {string} html
     * @returns {Promise<void>}
     */
    static _loadSrcdoc(iframe, html) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Sandboxed iframe did not finish loading within ${OffscreenParser.LOAD_TIMEOUT_MS}ms.`));
            }, OffscreenParser.LOAD_TIMEOUT_MS);

            function cleanup() {
                clearTimeout(timer);
                iframe.removeEventListener('load', onLoad);
                iframe.removeEventListener('error', onError);
            }
            function onLoad() { cleanup(); resolve(); }
            function onError() { cleanup(); reject(new Error('Sandboxed iframe failed to load.')); }

            iframe.addEventListener('load', onLoad);
            iframe.addEventListener('error', onError);
            iframe.srcdoc = html;
        });
    }

    // ─── Container detection (spec §4.3) ───────────────────────────────

    /**
     * Find the best content container: known selectors first, structural
     * scoring fallback second. Class names are never required for the
     * fallback — that's what survives Google renaming things.
     * @param {Document} idoc
     * @returns {{element: Element, method: 'selector:'+string|'structural-score'|'body-fallback'}}
     */
    static _findContainer(idoc) {
        for (const selector of OffscreenParser.CONTAINER_SELECTORS) {
            let el = null;
            try {
                el = idoc.querySelector(selector);
            } catch {
                el = null; // malformed selector never happens here, but stay defensive
            }
            if (el && el.tagName !== 'BODY' &&
                (el.textContent || '').trim().length >= OffscreenParser.MIN_ACCEPTABLE_TEXT_LENGTH) {
                return { element: el, method: `selector:${selector}` };
            }
        }

        const best = OffscreenParser._scoreCandidates(idoc);
        if (best) {
            return { element: best.candidate.ref, method: 'structural-score' };
        }

        return { element: idoc.body, method: 'body-fallback' };
    }

    /**
     * Structural fallback: measure every candidate block element and score
     * it via ContainerScore.scoreCandidate (pure, unit-tested). This thin
     * method is the "DOM-walking wrapper" — all scoring math lives in
     * lib/container-score.js.
     * @param {Document} idoc
     * @returns {{candidate: object, score: number}|null}
     */
    static _scoreCandidates(idoc) {
        if (!idoc.body) return null;

        const candidates = [];
        const elements = idoc.body.querySelectorAll(OffscreenParser.CANDIDATE_TAGS.join(','));

        for (const el of elements) {
            // Exclude nav/header/footer/aside AND anything nested inside them.
            if (el.closest('nav, header, footer, aside')) continue;

            const textLength = (el.textContent || '').length;
            if (textLength < OffscreenParser.MIN_ACCEPTABLE_TEXT_LENGTH) continue;

            candidates.push({
                tagName: el.tagName,
                textLength,
                linkTextLength: OffscreenParser._measureLinkTextLength(el),
                paragraphCount: el.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6').length,
                ref: el,
            });
        }

        // <body> is always eligible as a last-resort candidate so scoring
        // never comes back empty when there IS content on the page.
        candidates.push({
            tagName: 'BODY',
            textLength: (idoc.body.textContent || '').length,
            linkTextLength: OffscreenParser._measureLinkTextLength(idoc.body),
            paragraphCount: idoc.body.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6').length,
            ref: idoc.body,
        });

        return ContainerScore.pickBest(candidates);
    }

    /**
     * Sum the text length of every <a> descendant.
     * @param {Element} el
     * @returns {number}
     */
    static _measureLinkTextLength(el) {
        let total = 0;
        el.querySelectorAll('a').forEach((a) => { total += (a.textContent || '').length; });
        return total;
    }

    /**
     * Remove Google UI chrome found inside the chosen container.
     * @param {Element} container
     */
    static _removeNoise(container) {
        for (const selector of OffscreenParser.NOISE_SELECTORS) {
            container.querySelectorAll(selector).forEach((el) => el.remove());
        }
    }

    // ─── Title / plain text ─────────────────────────────────────────────

    /**
     * @param {Document} idoc
     * @param {Element} container
     * @returns {string}
     */
    static _extractTitle(idoc, container) {
        return (
            (idoc.title || '').replace(/ - Google (Docs|Sheets|Slides).*/, '').trim() ||
            container.querySelector('h1, h2, h3')?.textContent?.trim() ||
            'Untitled Document'
        );
    }

    /**
     * Read-only plain-text walk. Must run BEFORE any class/style-stripping
     * mutation below — not because mutation would lose text (it doesn't),
     * but so this stays a pure read pass with no ordering dependency on it.
     * @param {Document} idoc
     * @param {Element} container
     * @returns {string}
     */
    static _extractPlainText(idoc, container) {
        const textParts = [];
        const walker = idoc.createTreeWalker(
            container,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode(node) {
                    const tag = node.tagName;
                    if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'BR'].includes(tag)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                },
            }
        );

        let node;
        while ((node = walker.nextNode())) {
            const txt = node.textContent?.trim();
            if (txt) textParts.push(txt);
        }

        let text = textParts.join('\n\n');
        if (!text.trim()) {
            text = container.textContent || '';
        }
        return text.trim();
    }

    // ─── Cleaned HTML extraction (fixes D2, F1, F2; style engine is F3/spec §3) ──

    /**
     * Produce clean inner HTML for `container`, resolving bold/italic/
     * underline (spec §4.2) and the full style-fidelity engine (spec v2.1
     * §3) from `getComputedStyle` BEFORE stripping class/id. Runs in three
     * passes over the same element list:
     *
     *   Pass 1 (read-only)  — capture every element's formatting decision
     *                         (bold/italic/underline flags, the AUTHORED
     *                         `style` attribute text, and its own + its
     *                         parent's resolved `StyleFill.APPEARANCE_PROPERTIES`
     *                         values) while the original class-driven
     *                         cascade is still fully intact.
     *   Pass 2 (mutate)     — apply the structural half of those decisions:
     *                         wrap formatted <span>s as nested <b>/<i>/<u>
     *                         (F1 — carrying the merged style onto the
     *                         outermost new tag, spec §3.4), strip
     *                         class/id/role/dir, unwrap disallowed tags.
     *                         The `style` attribute itself is NOT written
     *                         here — see Pass 3.
     *   Pass 3 (style)      — `StyleFill.buildElementStyle` (pure, DOM-free)
     *                         turns each surviving element's captured
     *                         authored/computed values into its final
     *                         `style` attribute. Runs once with the
     *                         computed-fill included; if the resulting
     *                         `bodyHtml` exceeds the size budget (spec
     *                         §3.6), it re-runs authored-only and a
     *                         `style_fill_skipped_size` warning is added —
     *                         cheap to redo because it only touches
     *                         attributes, not structure.
     *
     * Splitting read from mutate matters: mutating element N (e.g.
     * stripping its class) before element N+1's style is read would be
     * fine in isolation, but re-reading computed style *after* any
     * upstream mutation risks the cascade no longer matching what was
     * originally rendered — capturing everything up front avoids the
     * question entirely.
     *
     * Element identity is preserved throughout (children are MOVED via
     * `appendChild`, never round-tripped through `innerHTML` reparsing) so
     * a node nested two levels inside a reformatted <span> still gets its
     * own class/style cleanup applied. Where an element IS replaced (the
     * span → b/i/u conversion, and the div → p normalisation below), its
     * Pass-1 decision is carried forward to the replacement in
     * `styleTargets` so Pass 3 still finds it.
     *
     * @param {Document} idoc
     * @param {Window} iwin
     * @param {Element} container
     * @returns {{html: string, warnings: string[]}}
     */
    static _extractBodyHtml(idoc, iwin, container) {
        const allEls = [...container.querySelectorAll('*')];

        // ── Pass 1: read authored + computed style decisions ───────────
        // `appearanceCache` avoids re-reading the same element's computed
        // style twice — most elements are visited once as "self" and again
        // as some sibling's "parent".
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
            // F1: a span may be more than one of bold/italic/underline at
            // once — nest rather than collapsing to a single tag.
            const formatTags = [];
            if (flags.bold) formatTags.push('b');
            if (flags.italic) formatTags.push('i');
            if (flags.underline) formatTags.push('u');

            const ownAppearance = computeAppearance(el, cs);
            appearanceCache.set(el, ownAppearance);
            const parentAppearance = getAppearance(el.parentElement || container);

            decisions.set(el, {
                formatTags,
                // Captured BEFORE Pass 2 removes it — this IS the authored
                // style (spec §3.1/§3.2), read the same way regardless of
                // whether it came from inline style="" or (for computed
                // properties below) a <style> class.
                authoredStyleText: el.getAttribute('style') || '',
                ownAppearance,
                parentAppearance,
            });
        }

        // Now that every decision is captured, remove the <style>/<script>/
        // <noscript> elements that drove the cascade — safe from here on.
        container.querySelectorAll('style, script, noscript').forEach((el) => el.remove());

        // ── Pass 2: mutate structure using the precomputed decisions ───
        // `styleTargets` maps each SURVIVING element (which may be a
        // replacement, not the original) to the Pass-1 decision Pass 3
        // will turn into its `style` attribute.
        const styleTargets = new Map();

        for (const el of allEls) {
            if (!el.isConnected) continue; // already excised (e.g. empty wrapper, or ancestor removed)

            // Drop empty span/div wrappers outright — they carry no content.
            if ((el.tagName === 'SPAN' || el.tagName === 'DIV') && !el.hasChildNodes()) {
                el.remove();
                continue;
            }

            const decision = decisions.get(el) || { formatTags: [], authoredStyleText: '', ownAppearance: {}, parentAppearance: {} };

            // F1: convert a formatted <span> into nested <b>/<i>/<u>, moving
            // (not reparsing) its children so their own identity/decisions
            // survive, and copying the span's merged style onto the
            // OUTERMOST new tag — nothing the span carried is lost, even
            // properties that duplicate what the tag itself now conveys
            // (e.g. font-weight:700 alongside <b>).
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
            // `style` is intentionally left untouched here — Pass 3 sets or
            // removes it from the precomputed decision, and may run twice
            // (spec §3.6 size budget), so nothing is written to it now.

            if (!OffscreenParser.ALLOWED_TAGS.has(el.tagName)) {
                const frag = idoc.createDocumentFragment();
                while (el.firstChild) frag.appendChild(el.firstChild);
                el.replaceWith(frag);
                continue; // unwrapped — no longer in the tree, nothing to style
            }

            styleTargets.set(el, decision);
        }

        // Normalise bare DIVs that only wrap inline content into <p> —
        // mobilebasic uses <div> for paragraphs. Carry the div's style
        // target forward to the replacement <p> so Pass 3 still finds it.
        container.querySelectorAll('div').forEach((div) => {
            const hasBlockChild = [...div.children].some((c) =>
                ['DIV', 'P', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)
            );
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

        // ── Pass 3: apply final styles (spec §3.6 size budget) ─────────
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
        if (sizeBytes > OffscreenParser.STYLE_FILL_SIZE_BUDGET_BYTES) {
            // Never silently truncate — drop the computed-fill pass (authored
            // styles only) and say so, instead of cutting the HTML short.
            applyStyles(false);
            html = container.innerHTML || '';
            warnings.push(WARNINGS.STYLE_FILL_SKIPPED_SIZE);
        }

        return { html, warnings };
    }
}

// ─── Message handling ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'parse') return undefined; // not for us

    (async () => {
        try {
            const data = await OffscreenParser.parseHtml(message.html, message.docType);
            sendResponse({ ok: true, data });
        } catch (err) {
            console.error('[OffscreenParser] parse failed:', err);
            sendResponse({ ok: false, error: err?.message || String(err) });
        }
    })();

    return true; // keep the message channel open for the async sendResponse above
});

console.log('[OffscreenParser] Ready.');
