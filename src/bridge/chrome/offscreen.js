/**
 * Lifecycle of the single offscreen document. The parse call itself lives in
 * bridge/to-offscreen.js.
 */
import { TIMING } from '../../lib/const.js';

const DOCUMENT_URL = 'src/offscreen/offscreen.html';

/** @type {number|null} */
let closeTimer = null;

/** Only one offscreen document may exist, so this is idempotent by design. */
export async function ensureDocument() {
    if (await chrome.offscreen.hasDocument()) return;

    try {
        await chrome.offscreen.createDocument({
            url: DOCUMENT_URL,
            reasons: ['DOM_PARSER'],
            justification:
                'Parse fetched Google Docs HTML off the visible DOM so formatting can be ' +
                'resolved through a real CSS cascade. No page scripts execute.',
        });
    } catch (err) {
        // A concurrent call may have won the race between hasDocument() and
        // createDocument() — that is success, not failure.
        if (!/single offscreen/i.test(err?.message || '')) throw err;
    }
}

/** Cheap to recreate, and leaving it open holds the service worker alive. */
export function scheduleClose() {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
        closeTimer = null;
        closeDocument().catch(() => { });
    }, TIMING.OFFSCREEN_IDLE_CLOSE_MS);
}

/** @returns {Promise<void>} */
export async function closeDocument() {
    if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
    }
}
