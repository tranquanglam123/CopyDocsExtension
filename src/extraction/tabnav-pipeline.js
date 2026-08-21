/**
 * tabnav-pipeline.js — Docs extraction, legacy v1 behaviour (DNR-block JS
 * on the tab, navigate to /mobilebasic, content script scrapes, restore
 * JS). Moved from background/service-worker.js's `runTabNavPipeline` and
 * `parseContentPayload` (spec v3 P2/P3).
 *
 * LAST-RESORT FALLBACK ONLY as of the T1/T2 fetch-transport fix: this is
 * the pipeline that redirects to support.google.com/accounts/answer/32050
 * in the real browser (see http-transport.js's file header), because
 * blocking scripts breaks Google's own cookie bootstrap.
 * `pipeline-runner.js`'s `dispatchTransport` only reaches this when
 * `fetch-pipeline.js`'s `runFetchHtmlPipeline` (T1 swFetch / T2 csFetch)
 * has already failed on every tier. Kept intact, not deleted — persisted
 * pipeline state + allocator rule ids (fixes D3/D4) unchanged.
 *
 * spec v3 P3: the content script's in-page fallback parser (DOMScanner) has
 * been deleted. `handleContentReady` below used to retry via a message
 * round trip back to the content script's `{action:'extract'}` handler
 * when the offscreen parse failed; that retry is gone, and a failed
 * offscreen parse is now fatal to this extraction (there is nothing left
 * to fall back to).
 */
import { DOC_TYPES, TRANSPORTS } from '../shared/constants.js';
import { PolicyManager } from '../platform/net-rules.js';
import { waitForTabLoad, navigateTab } from '../platform/tabs.js';
import { OffscreenManager } from '../platform/offscreen-host.js';
import { setExtractionComplete } from '../platform/storage.js';
import { PipelineState } from './pipeline-state.js';
import { embedImagesIntoResult } from './image-embedder.js';

/**
 * Pending extraction resolver.
 * When the content script sends 'contentReady', we resolve this promise
 * so runTabNavPipeline() can continue. This is a FAST PATH only — the
 * persisted PipelineState + watchdog alarm are the actual guarantee
 * that a tab never stays script-blocked (D3).
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

    // Written BEFORE the DNR rule is added — if the SW dies right
    // after this line, the watchdog/startup sweep still knows a rule
    // may exist for this tab and will remove it.
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

        // Create a promise that the content script will resolve when
        // it sends 'contentReady' after auto-injection.
        const contentPromise = new Promise((resolve, reject) => {
            _pendingExtraction = { resolve, reject };

            // Timeout after 20 seconds
            setTimeout(() => {
                if (_pendingExtraction) {
                    _pendingExtraction = null;
                    reject(new Error('Content extraction timed out (20s). The page may not have loaded correctly.'));
                }
            }, 20000);
        });

        // Navigate the tab to mobilebasic.
        // (This will likely close the popup — that's OK, results go to session storage)
        await navigateTab(tabId, target.url);

        // Wait for the page to finish loading
        await waitForTabLoad(tabId);

        await PipelineState.write({ phase: 'extracting' });

        // Wait for content script to send extracted data. The content
        // script is auto-injected by manifest content_scripts and runs
        // its own readiness detector (spec §4.4) before scanning.
        const extractedData = await contentPromise;

        extractedData.meta = {
            ...(extractedData.meta || {}),
            transport: TRANSPORTS.TAB_NAV,
            docType: DOC_TYPES.DOCS,
            docId,
        };

        // Store the final result (already done in handleContentReady, but ensure)
        await setExtractionComplete(extractedData);

        return extractedData;

    } finally {
        // Always restore JavaScript and release the rule id — this
        // `finally` is now a FAST PATH, not the only guarantee (D3).
        // The watchdog alarm and the startup sweep back it up.
        await PolicyManager.restoreJavaScript(ruleId);
        await PolicyManager.releaseRuleId(ruleId);
        await PipelineState.clear();
    }
}

/**
 * Turn a content-script payload into the extraction result contract.
 *
 * The content script ships raw HTML and lets the offscreen parser do the
 * work, because only a real CSS cascade can resolve Google's class-based
 * formatting (D2). Per spec v3 P3, there is no in-page fallback parser any
 * more — an offscreen-parser failure is fatal to this extraction.
 *
 * @param {object} payload   { rawHtml, title, url, docType }
 * @param {number|undefined} tabId  Sending tab, used for image embedding's
 *   T2 csFetch fallback.
 * @returns {Promise<object>}
 */
export async function handleContentReady(payload, tabId) {
    if (!payload) throw new Error('Content script sent an empty payload.');
    if (!payload.rawHtml) throw new Error('Content script payload is missing rawHtml.');

    let result;
    try {
        const parsed = await OffscreenManager.parse(payload.rawHtml, payload.docType || DOC_TYPES.DOCS);
        result = {
            ...parsed,
            meta: { ...(parsed.meta || {}), transport: TRANSPORTS.TAB_NAV },
        };
        result = await embedImagesIntoResult(result, tabId);
    } catch (err) {
        console.error('[tabnav-pipeline] Offscreen parse failed — no fallback parser is available:', err);
        throw new Error(`Extraction failed: the offscreen parser could not process this document (${err.message}).`);
    }

    await setExtractionComplete(result);

    // If runTabNavPipeline() is waiting for this, resolve it.
    if (_pendingExtraction) {
        _pendingExtraction.resolve(result);
        _pendingExtraction = null;
    }

    return result;
}
