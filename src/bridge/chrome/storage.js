/**
 * Typed wrappers over chrome.storage.session/local, keyed by lib/const.js.
 * netrules.js keeps its own allocator bookkeeping; everything else comes here.
 */
import { SESSION_KEYS, LOCAL_KEYS, EXTRACTION_STATUS } from '../../lib/const.js';

// ─── Generic session helpers ──────────────────────────────────────────────

/** @param {string|string[]} keys @returns {Promise<object>} */
export async function sessionGet(keys) {
    return chrome.storage.session.get(keys);
}

/** @param {object} items @returns {Promise<void>} */
export async function sessionSet(items) {
    return chrome.storage.session.set(items);
}

/** @param {string|string[]} keys @returns {Promise<void>} */
export async function sessionRemove(keys) {
    return chrome.storage.session.remove(keys);
}

// ─── Extraction status: the popup-facing contract ─────────────────────────

/**
 * @returns {Promise<{lastExtraction: object|null, status: string, error: string|null}>}
 */
export async function getExtractionState() {
    const stored = await chrome.storage.session.get([
        SESSION_KEYS.LAST_EXTRACTION,
        SESSION_KEYS.EXTRACTION_STATUS,
        SESSION_KEYS.LAST_EXTRACTION_ERROR,
    ]);
    return {
        lastExtraction: stored[SESSION_KEYS.LAST_EXTRACTION] || null,
        status: stored[SESSION_KEYS.EXTRACTION_STATUS] || EXTRACTION_STATUS.IDLE,
        error: stored[SESSION_KEYS.LAST_EXTRACTION_ERROR] || null,
    };
}

/** Mark a new extraction as in-progress, clearing any previous result. */
export async function setExtractionRunning() {
    await chrome.storage.session.set({
        [SESSION_KEYS.EXTRACTION_STATUS]: EXTRACTION_STATUS.RUNNING,
        [SESSION_KEYS.LAST_EXTRACTION]: null,
        [SESSION_KEYS.LAST_EXTRACTION_ERROR]: null,
    });
}

/** @param {string} status */
export async function setExtractionStatus(status) {
    await chrome.storage.session.set({ [SESSION_KEYS.EXTRACTION_STATUS]: status });
}

/** @param {string} message */
export async function setExtractionError(message) {
    await chrome.storage.session.set({
        [SESSION_KEYS.EXTRACTION_STATUS]: EXTRACTION_STATUS.ERROR,
        [SESSION_KEYS.LAST_EXTRACTION_ERROR]: message,
    });
}

/** @param {object} result */
export async function setExtractionComplete(result) {
    await chrome.storage.session.set({
        [SESSION_KEYS.LAST_EXTRACTION]: result,
        [SESSION_KEYS.EXTRACTION_STATUS]: EXTRACTION_STATUS.COMPLETE,
    });
}

// ─── Embed-images toggle ──────────────────────────────────────────────────
// .local, not .session: it is a setting, so it outlives one extraction.
// Default ON, with the toggle as the escape hatch for a paste target that
// rejects data: URIs.

/** @returns {Promise<boolean>} */
export async function isEmbedImagesEnabled() {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.EMBED_IMAGES);
    const value = stored[LOCAL_KEYS.EMBED_IMAGES];
    return value === undefined ? true : !!value;
}
