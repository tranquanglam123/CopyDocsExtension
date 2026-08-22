/**
 * Persisted state of the in-flight extraction:
 * `{ phase, tabId, ruleId, startedAt, docId }`.
 */
import { SESSION_KEYS } from '../../lib/const.js';
import { sessionGet, sessionSet, sessionRemove } from '../../bridge/chrome/storage.js';

export class PipelineState {

    static STORAGE_KEY = SESSION_KEYS.PIPELINE;

    /**
     * Callers write before every side effect, so a killed service worker
     * always leaves the watchdog an accurate breadcrumb.
     * @param {object} partial
     * @returns {Promise<object>} The full pipeline object after the merge.
     */
    static async write(partial) {
        const existing = await PipelineState.get();
        const next = { ...(existing || {}), ...partial };
        await sessionSet({ [PipelineState.STORAGE_KEY]: next });
        return next;
    }

    /**
     * @returns {Promise<object|null>}
     */
    static async get() {
        const stored = await sessionGet(PipelineState.STORAGE_KEY);
        return stored[PipelineState.STORAGE_KEY] || null;
    }

    /**
     * @returns {Promise<void>}
     */
    static async clear() {
        await sessionRemove(PipelineState.STORAGE_KEY);
    }
}
