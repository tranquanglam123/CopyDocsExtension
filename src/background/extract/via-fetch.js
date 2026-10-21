/**
 * Docs extraction over http.js's two tiers. No DNR rule, no tab navigation.
 * Both tiers failing throws, and run.js falls back to via-tabnav.js.
 */
import { DOC_TYPES, FILE_LIMITS } from '../../lib/const.js';
import { sniffFileType } from '../../lib/embed.js';
import { fetchDocHtml } from './http.js';
import { swFetchBinary } from './binary.js';
import { toDocxExport } from './route.js';
import { embedImagesIntoResult } from './image.js';
import { PipelineState } from './state.js';
import { parse } from '../../bridge/to-offscreen.js';
import { setExtractionComplete } from '../../bridge/chrome/storage.js';

/**
 * @param {object} tab   The active tab (chrome tabs.Tab shape).
 * @param {{url: string, parser: string, mode: string}} target
 * @param {string} docId
 * @returns {Promise<object>}
 */
export async function runFetchHtmlPipeline(tab, target, docId) {
    const tabId = tab.id;
    await PipelineState.write({
        phase: 'fetching',
        tabId,
        ruleId: null,
        startedAt: Date.now(),
        docId,
    });

    try {
        // In parallel with the HTML, which stays the source of everything else.
        const exported = fetchDocxExport(docId);
        const { html, transport } = await fetchDocHtml({ url: target.url, tabId });

        await PipelineState.write({ phase: 'parsing' });

        const parsed = await parse(html, DOC_TYPES.DOCS);
        const docx = await exported;

        let result = {
            ...parsed,
            ...(docx ? { docx } : {}),
            meta: {
                ...(parsed.meta || {}),
                transport,
                docType: DOC_TYPES.DOCS,
                docId,
            },
        };

        await PipelineState.write({ phase: 'embedding-images' });
        result = await embedImagesIntoResult(result, tabId);

        await setExtractionComplete(result, docId);

        return result;
    } finally {
        // No DNR rule and no tab was ever touched — clearing the
        // pipeline slot is the only cleanup needed (mirrors
        // via-csv.js's runSwFetchPipeline).
        await PipelineState.clear();
    }
}

/**
 * Google's own .docx of the document, so the .docx download is identical to
 * it; null when the owner disabled downloads or anything else goes wrong.
 * @param {string} docId
 * @returns {Promise<string|null>} base64
 */
export async function fetchDocxExport(docId) {
    try {
        const file = await swFetchBinary(toDocxExport(docId), FILE_LIMITS.EXPORT_TIMEOUT_MS);
        if (!file.ok || !file.byteLength || file.byteLength > FILE_LIMITS.MAX_BYTES) return null;
        return sniffFileType(atob(file.base64.slice(0, 8))) === 'zip' ? file.base64 : null;
    } catch (err) {
        console.warn('[extract/fetch] .docx export unavailable:', err.message);
        return null;
    }
}
