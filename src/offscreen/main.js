/**
 * Offscreen document (reasons: ['DOM_PARSER']). Takes raw fetched HTML, or a
 * PDF/DOCX file, from the service worker and returns the structured-content
 * shape.
 *
 * The HTML is loaded into a sandboxed iframe so the document's own <style>
 * block resolves in a real CSS cascade: mobilebasic puts bold/italic in
 * classes, which reading `node.style` alone would silently drop.
 */

import { HtmlSanitize } from '../lib/sanitize.js';
import { wrapAsDocument } from '../lib/html.js';
import { WARNINGS } from '../lib/const.js';
import { onParseRequest, onParseFileRequest } from '../bridge/chrome/runtime.js';
import { createSandbox, loadSrcdoc } from './sandbox.js';
import { findContainer, removeNoise } from './pass/container.js';
import { extractTitle } from './pass/title.js';
import { extractPlainText } from './pass/text.js';
import { extractBodyHtml } from './pass/html.js';
import { parseFile } from './file/index.js';

/**
 * @param {string} html
 * @param {string} [docType]
 * @returns {Promise<{title:string, text:string, html:string, bodyHtml:string, charCount:number, meta:object}>}
 */
async function parseHtml(html, docType) {
    if (typeof html !== 'string' || !html) {
        throw new Error('parseHtml requires a non-empty HTML string.');
    }

    const iframe = createSandbox();
    document.body.appendChild(iframe);

    try {
        await loadSrcdoc(iframe, html);

        const idoc = iframe.contentDocument;
        const iwin = iframe.contentWindow;
        if (!idoc || !iwin) {
            throw new Error('Could not access the sandboxed iframe document (allow-same-origin missing?).');
        }

        // Before anything is read. Leaves <style> and class intact, so the
        // cascade the passes below need survives.
        HtmlSanitize.sanitize(idoc);

        const { element: container, method } = findContainer(idoc);
        removeNoise(container);

        const title = extractTitle(idoc, container);
        const text = extractPlainText(idoc, container);
        const { html: bodyHtml, warnings: styleWarnings } = extractBodyHtml(idoc, iwin, container);
        const charCount = text.length;

        const warnings = [...styleWarnings];
        if (charCount === 0) warnings.push(WARNINGS.EMPTY_CONTENT);
        if (method === 'structural-score') warnings.push(WARNINGS.CONTAINER_FALLBACK_USED);
        if (method === 'body-fallback') warnings.push(WARNINGS.CONTAINER_NOT_FOUND);

        return {
            title,
            text,
            html: wrapAsDocument(bodyHtml, title),
            bodyHtml,
            charCount,
            meta: {
                // The caller fills strategyId/transport/tab and sheet counts —
                // it has that context, this parser only sees the HTML.
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

onParseRequest(parseHtml);
onParseFileRequest(parseFile);
