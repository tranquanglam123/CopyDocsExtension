/**
 * offscreen-host.js — OffscreenManager: bridge to entry/offscreen.js (spec
 * v3 §2/§4 P2, was formerly documented as spec §4.1). Moved from
 * background/service-worker.js. The service worker has no DOM, so all HTML
 * parsing happens in a single offscreen document, which loads the markup
 * into a sandboxed iframe and resolves formatting through a real CSS
 * cascade (the D2 fix).
 */
import { TIMING } from '../shared/constants.js';

export class OffscreenManager {

    static DOCUMENT_URL = 'src/entry/offscreen.html';

    /** Close the document after this much idle time. */
    static IDLE_CLOSE_MS = TIMING.OFFSCREEN_IDLE_CLOSE_MS;

    /** @type {number|null} */
    static _closeTimer = null;

    /**
     * Create the offscreen document if it isn't already open. Only one may
     * exist at a time, so this is idempotent by design.
     * @returns {Promise<void>}
     */
    static async ensure() {
        if (await chrome.offscreen.hasDocument()) return;

        try {
            await chrome.offscreen.createDocument({
                url: OffscreenManager.DOCUMENT_URL,
                reasons: ['DOM_PARSER'],
                justification:
                    'Parse fetched Google Docs HTML off the visible DOM so formatting can be ' +
                    'resolved through a real CSS cascade. No page scripts execute.',
            });
        } catch (err) {
            // A concurrent call may have won the race between hasDocument()
            // and createDocument() — that is success, not failure.
            if (!/single offscreen/i.test(err?.message || '')) throw err;
        }
    }

    /**
     * Parse raw HTML into the extraction result contract.
     * @param {string} html      Raw document HTML.
     * @param {string} docType   'docs' | 'sheets' | 'slides'
     * @returns {Promise<object>} { title, text, html, bodyHtml, charCount, meta }
     */
    static async parse(html, docType) {
        await OffscreenManager.ensure();

        const response = await chrome.runtime.sendMessage({ type: 'parse', html, docType });
        if (!response?.ok) {
            throw new Error(response?.error || 'Offscreen parse failed.');
        }

        OffscreenManager._scheduleClose();
        return response.data;
    }

    /**
     * Close the offscreen document after an idle period. Cheap to recreate,
     * and leaving it open holds the service worker alive unnecessarily.
     * @private
     */
    static _scheduleClose() {
        if (OffscreenManager._closeTimer !== null) {
            clearTimeout(OffscreenManager._closeTimer);
        }
        OffscreenManager._closeTimer = setTimeout(() => {
            OffscreenManager._closeTimer = null;
            OffscreenManager.close().catch(() => { });
        }, OffscreenManager.IDLE_CLOSE_MS);
    }

    /**
     * @returns {Promise<void>}
     */
    static async close() {
        if (await chrome.offscreen.hasDocument()) {
            await chrome.offscreen.closeDocument();
        }
    }
}
