/**
 * pipeline-state.js — PipelineState: persisted state machine for the
 * in-flight extraction (fixes D3). Moved from background/service-worker.js.
 * Shape: { phase, tabId, ruleId, startedAt, docId }
 *
 * Goes through platform/storage.js's generic session helpers rather than
 * calling the storage API directly, so this stays free of Chrome APIs
 * (spec v3 §2 — src/extraction/ imports platform/, it doesn't call any
 * Chrome API itself). The merge-write logic itself is unchanged.
 */
import { SESSION_KEYS } from '../../lib/const.js';
import { sessionGet, sessionSet, sessionRemove } from '../../bridge/chrome/storage.js';

export class PipelineState {

    static STORAGE_KEY = SESSION_KEYS.PIPELINE;

    /**
     * Merge-write partial pipeline state. Callers write BEFORE every side
     * effect (rule add, tab navigate, fetch) so a killed service worker
     * always leaves behind an accurate breadcrumb for the watchdog.
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
