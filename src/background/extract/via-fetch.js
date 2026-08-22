/**
 * fetch-pipeline.js — Docs extraction via the fetch transport (spec §3.2,
 * T1 `swFetch` then T2 `csFetch`). Moved from background/service-worker.js's
 * `runFetchHtmlPipeline`.
 *
 * No DNR rule, no tab navigation — the user's tab is never touched.
 * If both fetch tiers fail, this throws and the caller
 * (`pipeline-runner.js`'s `dispatchTransport`) falls back to
 * `tabnav-pipeline.js`'s `runTabNavPipeline`. See http-transport.js's file
 * header for why this exists instead of tabNav-only.
 */
import { DOC_TYPES } from '../../lib/const.js';
import { fetchDocHtml } from './http.js';
import { embedImagesIntoResult } from './image.js';
import { PipelineState } from './state.js';
import { OffscreenManager } from '../../bridge/chrome/offscreen.js';
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

        const parsed = await OffscreenManager.parse(html, DOC_TYPES.DOCS);

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
        // csv-pipeline.js's runSwFetchPipeline).
        await PipelineState.clear();
    }
}
