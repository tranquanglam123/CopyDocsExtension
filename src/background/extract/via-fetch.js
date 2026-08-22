/**
 * Docs extraction over http.js's two tiers. No DNR rule, no tab navigation.
 * Both tiers failing throws, and run.js falls back to via-tabnav.js.
 */
import { DOC_TYPES } from '../../lib/const.js';
import { fetchDocHtml } from './http.js';
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
        const { html, transport } = await fetchDocHtml({ url: target.url, tabId });

        await PipelineState.write({ phase: 'parsing' });

        const parsed = await parse(html, DOC_TYPES.DOCS);

        let result = {
            ...parsed,
            meta: {
                ...(parsed.meta || {}),
                transport,
                docType: DOC_TYPES.DOCS,
                docId,
            },
        };

        await PipelineState.write({ phase: 'embedding-images' });
        result = await embedImagesIntoResult(result, tabId);

        await setExtractionComplete(result);

        return result;
    } finally {
        // No DNR rule and no tab was ever touched — clearing the
        // pipeline slot is the only cleanup needed (mirrors
        // via-csv.js's runSwFetchPipeline).
        await PipelineState.clear();
    }
}
