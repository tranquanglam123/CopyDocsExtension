/**
 * storage.js — typed wrappers over chrome.storage.session/local, keyed by
 * the names in shared/constants.js (spec v3 §2/§4 P3). Besides
 * platform/net-rules.js (which owns its own rule-allocation bookkeeping —
 * see that file's header, kept move-don't-touch), this is the only place
 * that calls chrome.storage.* directly; extraction/pipeline-state.js and
 * the pipeline modules go through the functions here so `src/extraction/`
 * stays chrome-free.
 */
import { SESSION_KEYS, LOCAL_KEYS, EXTRACTION_STATUS } from '../../lib/const.js';

// ─── Generic session helpers (used by extraction/pipeline-state.js) ───────

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

// ─── Extraction status (spec §5, popup-facing contract) ────────────────────

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

// ─── Embed-images toggle (spec §4.4) ───────────────────────────────────────
// Lives in chrome.storage.local (not .session) so it persists like a normal
// setting, across browser restarts, not just across one extraction.
// Default ON: whether Google Docs actually accepts `data:` URI images on
// paste is unverified (spec §8 Q1), so ON is the useful-by-default guess
// and the toggle is the escape hatch if that guess turns out to be wrong
// for a given user/session.

/** @returns {Promise<boolean>} */
export async function isEmbedImagesEnabled() {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.EMBED_IMAGES);
    const value = stored[LOCAL_KEYS.EMBED_IMAGES];
    return value === undefined ? true : !!value;
}
