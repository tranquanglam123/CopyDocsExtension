/**
 * Docs extraction the legacy way: block JS on the tab, navigate to
 * /mobilebasic, let the content script scrape, restore JS.
 *
 * Last resort only. This is the path that redirects to the "clear cache and
 * cookies" page, because blocking scripts breaks Google's cookie bootstrap.
 * run.js reaches it only after every fetch tier has failed.
 *
 * There is no in-page fallback parser any more, so a failed offscreen parse
 * is fatal to this extraction.
 */
import { DOC_TYPES, TRANSPORTS } from '../../lib/const.js';
import { AppError } from '../../lib/error.js';
import { PolicyManager } from '../../bridge/chrome/netrules.js';
import { waitForTabLoad, navigateTab } from '../../bridge/chrome/tabs.js';
import { parse } from '../../bridge/to-offscreen.js';
import { setExtractionComplete } from '../../bridge/chrome/storage.js';
import { PipelineState } from './state.js';
import { embedImagesIntoResult } from './image.js';

/**
 * Resolved when the content script sends 'contentReady'. A fast path only —
 * the persisted state and the watchdog are what actually guarantee a tab
 * never stays script-blocked.
 * @type {{ resolve: Function, reject: Function } | null}
 */
let _pendingExtraction = null;

/**
 * @param {object} tab   The active tab (chrome tabs.Tab shape).
 * @param {{url: string, parser: string, mode: string}} target
 * @param {string} docId
 * @returns {Promise<object>}
 */
export async function runTabNavPipeline(tab, target, docId) {
    const tabId = tab.id;
    const ruleId = await PolicyManager.allocateRuleId(tabId);

    // Written before the DNR rule exists, so a service worker killed on the
    // next line still leaves the sweep a breadcrumb.
    await PipelineState.write({
        phase: 'blocking',
        tabId,
        ruleId,
        startedAt: Date.now(),
        docId,
    });

    await PolicyManager.blockJavaScript(tabId, ruleId);

    try {
        await PipelineState.write({ phase: 'navigating' });

        // Resolved by 'contentReady' after auto-injection.
        const contentPromise = new Promise((resolve, reject) => {
            _pendingExtraction = { resolve, reject };

            // Timeout after 20 seconds
            setTimeout(() => {
                if (_pendingExtraction) {
                    _pendingExtraction = null;
                    reject(new AppError('error.contentExtractionTimeout'));
                }
            }, 20000);
        });

        // Likely closes the popup; results go to session storage.
        await navigateTab(tabId, target.url);

        // Wait for the page to finish loading
        await waitForTabLoad(tabId);

        await PipelineState.write({ phase: 'extracting' });

        // The content script is auto-injected and runs its own readiness
        // detector before sending.
        const extractedData = await contentPromise;

        extractedData.meta = {
            ...(extractedData.meta || {}),
            transport: TRANSPORTS.TAB_NAV,
            docType: DOC_TYPES.DOCS,
            docId,
        };

        // handleContentReady already stored this; make sure.
        await setExtractionComplete(extractedData);

        return extractedData;

    } finally {
        // A fast path, not the only guarantee — the watchdog and the
        // startup sweep back it up.
        await PolicyManager.restoreJavaScript(ruleId);
        await PolicyManager.releaseRuleId(ruleId);
        await PipelineState.clear();
    }
}

/**
 * The content script ships raw HTML because only a real CSS cascade resolves
 * Google's class-based formatting. A parser failure is fatal here.
 *
 * @param {object} payload   { rawHtml, title, url, docType }
 * @param {number|undefined} tabId  Sending tab, used for image embedding's
 *   T2 csFetch fallback.
 * @returns {Promise<object>}
 */
export async function handleContentReady(payload, tabId) {
    if (!payload) throw new AppError('error.emptyPayload');
    if (!payload.rawHtml) throw new AppError('error.missingRawHtml');

    let result;
    try {
        const parsed = await parse(payload.rawHtml, payload.docType || DOC_TYPES.DOCS);
        result = {
            ...parsed,
            meta: { ...(parsed.meta || {}), transport: TRANSPORTS.TAB_NAV },
        };
        result = await embedImagesIntoResult(result, tabId);
    } catch (err) {
        console.error('[extract/via-tabnav] Offscreen parse failed — no fallback parser is available:', err);
        throw new AppError('error.offscreenParseFailed', { message: err.message });
    }

    await setExtractionComplete(result);

    // Release the pipeline if it is waiting.
    if (_pendingExtraction) {
        _pendingExtraction.resolve(result);
        _pendingExtraction = null;
    }

    return result;
}
