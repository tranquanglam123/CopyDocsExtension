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

import { HtmlSanitize } from '../lib/html-sanitize.js';
import { StyleDecision } from '../lib/style-decision.js';
import { ContainerScore } from '../lib/container-score.js';

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
        'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'CAPTION',
        'A',
        'BLOCKQUOTE', 'PRE', 'CODE',
        'SPAN', 'DIV',
        'IMG',
    ]);

    /** Block-level tags where paragraph alignment / indent are worth keeping. */
    static ALIGN_INDENT_TAGS = new Set([
        'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE',
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
    static LOAD_TIMEOUT_MS = 10000;

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
            const bodyHtml = OffscreenParser._extractBodyHtml(idoc, iwin, container);
            const fullHtml = OffscreenParser.wrapAsDocument(bodyHtml, title);
            const charCount = text.length;

            const warnings = [];
            if (charCount === 0) warnings.push('empty_content');
            if (method === 'structural-score') warnings.push('container_fallback_used');
            if (method === 'body-fallback') warnings.push('container_not_found');

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
     * @returns {HTMLIFrameElement}
     */
    static _createSandbox() {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-same-origin');
        iframe.style.cssText = 'position:absolute; width:0; height:0; border:0; visibility:hidden;';
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

    // ─── Cleaned HTML extraction (fixes D2) ─────────────────────────────

    /**
     * Produce clean inner HTML for `container`, resolving bold/italic/
     * underline/alignment/indent from `getComputedStyle` BEFORE stripping
     * class/id (spec §4.2). Runs in two passes over the same element list:
     *
     *   Pass 1 (read-only)  — capture every element's formatting decision
     *                         while the original class-driven cascade is
     *                         still fully intact.
     *   Pass 2 (mutate)     — apply those precomputed decisions: wrap
     *                         formatted <span>s as <b>/<i>/<u>, strip
     *                         class/id/style, unwrap disallowed tags.
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
     * own class/style cleanup applied.
     *
     * @param {Document} idoc
     * @param {Window} iwin
     * @param {Element} container
     * @returns {string}
     */
    static _extractBodyHtml(idoc, iwin, container) {
        const allEls = [...container.querySelectorAll('*')];

        // ── Pass 1: read computed style decisions ──────────────────────
        const decisions = new Map();
        for (const el of allEls) {
            const cs = iwin.getComputedStyle(el);
            const tag = StyleDecision.styleToTag({
                fontWeight: cs.fontWeight,
                fontStyle: cs.fontStyle,
                textDecorationLine: cs.textDecorationLine || cs.textDecoration,
            });

            let textAlign = null;
            let marginLeft = null;
            if (OffscreenParser.ALIGN_INDENT_TAGS.has(el.tagName)) {
                const align = cs.textAlign;
                if (align && !['start', 'left', 'normal', ''].includes(align)) {
                    textAlign = align;
                }
                const margin = parseFloat(cs.marginLeft);
                if (margin && margin > 0) {
                    marginLeft = cs.marginLeft;
                }
            }

            decisions.set(el, { tag, textAlign, marginLeft });
        }

        // Now that every decision is captured, remove the <style>/<script>/
        // <noscript> elements that drove the cascade — safe from here on.
        container.querySelectorAll('style, script, noscript').forEach((el) => el.remove());

        // ── Pass 2: mutate using the precomputed decisions only ────────
        for (const el of allEls) {
            if (!el.isConnected) continue; // already excised (e.g. empty wrapper, or ancestor removed)

            // Drop empty span/div wrappers outright — they carry no content.
            if ((el.tagName === 'SPAN' || el.tagName === 'DIV') && !el.hasChildNodes()) {
                el.remove();
                continue;
            }

            const decision = decisions.get(el) || { tag: null, textAlign: null, marginLeft: null };

            // Convert a formatted <span> into <b>/<i>/<u>, moving (not
            // reparsing) its children so their own identity/decisions survive.
            if (el.tagName === 'SPAN' && decision.tag) {
                const repl = idoc.createElement(decision.tag);
                while (el.firstChild) repl.appendChild(el.firstChild);
                el.replaceWith(repl);
                continue;
            }

            el.removeAttribute('class');
            el.removeAttribute('id');
            el.removeAttribute('data-aria-level');
            el.removeAttribute('data-aria-posinset');
            el.removeAttribute('role');
            el.removeAttribute('dir');
            el.removeAttribute('style'); // drop inline style; only re-add what we explicitly kept below

            const kept = [];
            if (decision.textAlign) kept.push(`text-align:${decision.textAlign}`);
            if (decision.marginLeft) kept.push(`margin-left:${decision.marginLeft}`);
            if (kept.length > 0) el.setAttribute('style', kept.join(';'));

            if (!OffscreenParser.ALLOWED_TAGS.has(el.tagName)) {
                const frag = idoc.createDocumentFragment();
                while (el.firstChild) frag.appendChild(el.firstChild);
                el.replaceWith(frag);
            }
        }

        // Normalise bare DIVs that only wrap inline content into <p> —
        // mobilebasic uses <div> for paragraphs.
        container.querySelectorAll('div').forEach((div) => {
            const hasBlockChild = [...div.children].some((c) =>
                ['DIV', 'P', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)
            );
            if (!hasBlockChild && div.textContent.trim()) {
                const p = idoc.createElement('p');
                if (div.hasAttribute('style')) p.setAttribute('style', div.getAttribute('style'));
                while (div.firstChild) p.appendChild(div.firstChild);
                div.replaceWith(p);
            }
        });

        return container.innerHTML || '';
    }

    // ─── Output wrapper (reused verbatim from the legacy DOMScanner) ────

    /**
     * Wrap cleaned HTML in a minimal document structure suitable for
     * Word/Google Docs import / rich clipboard copy.
     * @param {string} bodyHtml
     * @param {string} title
     * @returns {string}
     */
    static wrapAsDocument(bodyHtml, title) {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${OffscreenParser.escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; max-width: 800px; margin: 20px auto; color: #222; }
  h1 { font-size: 20pt; margin: 16pt 0 8pt; }
  h2 { font-size: 16pt; margin: 14pt 0 6pt; }
  h3 { font-size: 13pt; margin: 12pt 0 4pt; }
  p { margin: 0 0 8pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  td, th { border: 1px solid #ccc; padding: 6px 8px; }
  th { background: #f5f5f5; font-weight: bold; }
  blockquote { border-left: 3px solid #ccc; margin: 8pt 0; padding: 4pt 12pt; color: #555; }
  ul, ol { margin: 4pt 0 8pt 20pt; }
  li { margin: 2pt 0; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
    }

    /**
     * Escape HTML entities in a string.
     * @param {string} str
     * @returns {string}
     */
    static escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
