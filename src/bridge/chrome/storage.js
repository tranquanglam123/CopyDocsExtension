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
    const [local, session] = await Promise.all([
        chrome.storage.local.get(LOCAL_KEYS.LAST_EXTRACTION),
        chrome.storage.session.get([
            SESSION_KEYS.EXTRACTION_STATUS,
            SESSION_KEYS.LAST_EXTRACTION_ERROR,
        ]),
    ]);
    return {
        lastExtraction: local[LOCAL_KEYS.LAST_EXTRACTION] || null,
        status: session[SESSION_KEYS.EXTRACTION_STATUS] || EXTRACTION_STATUS.IDLE,
        error: session[SESSION_KEYS.LAST_EXTRACTION_ERROR] || null,
    };
}

/** Mark a new extraction as in-progress, clearing any previous result. */
export async function setExtractionRunning() {
    await Promise.all([
        chrome.storage.local.remove(LOCAL_KEYS.LAST_EXTRACTION),
        chrome.storage.session.set({
            [SESSION_KEYS.EXTRACTION_STATUS]: EXTRACTION_STATUS.RUNNING,
            [SESSION_KEYS.LAST_EXTRACTION_ERROR]: null,
        }),
    ]);
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

/**
 * `docId` is stamped into the result: a stored result outlives the tab it
 * came from, and without it the popup cannot tell whose result it holds.
 * @param {object} result
 * @param {string} docId
 */
export async function setExtractionComplete(result, docId) {
    await Promise.all([
        chrome.storage.local.set({
            [LOCAL_KEYS.LAST_EXTRACTION]: { ...result, meta: { ...(result.meta || {}), docId } },
        }),
        chrome.storage.session.set({
            [SESSION_KEYS.EXTRACTION_STATUS]: EXTRACTION_STATUS.COMPLETE,
        }),
    ]);
}

/** Clear the finished result so the popup offers the current tab again. */
export async function clearExtractionState() {
    await Promise.all([
        chrome.storage.local.remove(LOCAL_KEYS.LAST_EXTRACTION),
        chrome.storage.session.remove([
            SESSION_KEYS.EXTRACTION_STATUS,
            SESSION_KEYS.LAST_EXTRACTION_ERROR,
        ]),
    ]);
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

// ─── Self-update ──────────────────────────────────────────────────────────

/** @returns {Promise<object|null>} The last update check, see background/update.js. */
export async function getUpdateInfo() {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.UPDATE_INFO);
    return stored[LOCAL_KEYS.UPDATE_INFO] || null;
}

/** @param {object} info */
export async function setUpdateInfo(info) {
    await chrome.storage.local.set({ [LOCAL_KEYS.UPDATE_INFO]: info });
}
