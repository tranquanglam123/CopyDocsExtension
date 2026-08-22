/**
 * DNR rule id allocation, JS block and restore, stale-rule sweep. Part of
 * what stops a tab being left script-blocked when the worker dies.
 */
import { RULE_ID_BAND, SESSION_KEYS } from '../../lib/const.js';

export class PolicyManager {

    /** Session DNR rule id band reserved for this extension. */
    static RULE_ID_MIN = RULE_ID_BAND.MIN;
    static RULE_ID_MAX = RULE_ID_BAND.MAX;

    static ALLOC_KEY = SESSION_KEYS.RULE_ALLOC;

    /**
     * Lowest free id in the band — `BASE + (tabId % 1000)` collided for tab
     * ids 1000 apart. Persisted before the rule exists so a sweep finds it.
     * @param {number} tabId
     * @returns {Promise<number>} The allocated rule id.
     */
    static async allocateRuleId(tabId) {
        const { [PolicyManager.ALLOC_KEY]: ruleAlloc = {} } =
            await chrome.storage.session.get(PolicyManager.ALLOC_KEY);

        const used = new Set(Object.keys(ruleAlloc).map(Number));
        for (let id = PolicyManager.RULE_ID_MIN; id <= PolicyManager.RULE_ID_MAX; id++) {
            if (!used.has(id)) {
                ruleAlloc[id] = tabId;
                await chrome.storage.session.set({ [PolicyManager.ALLOC_KEY]: ruleAlloc });
                return id;
            }
        }

        throw new Error(
            `Rule ID band exhausted (${PolicyManager.RULE_ID_MIN}-${PolicyManager.RULE_ID_MAX}) — ` +
            'too many concurrent extractions in flight. Close some tabs and try again.'
        );
    }

    /**
     * Safe to call twice, or with an id that was never allocated.
     * @param {number|null|undefined} ruleId
     * @returns {Promise<void>}
     */
    static async releaseRuleId(ruleId) {
        if (ruleId === null || ruleId === undefined) return;
        const { [PolicyManager.ALLOC_KEY]: ruleAlloc = {} } =
            await chrome.storage.session.get(PolicyManager.ALLOC_KEY);
        if (ruleAlloc[ruleId] !== undefined) {
            delete ruleAlloc[ruleId];
            await chrome.storage.session.set({ [PolicyManager.ALLOC_KEY]: ruleAlloc });
        }
    }

    /**
     * Find the rule id (if any) allocated to a given tab.
     * @param {number} tabId
     * @returns {Promise<number|null>}
     */
    static async ruleIdForTab(tabId) {
        const { [PolicyManager.ALLOC_KEY]: ruleAlloc = {} } =
            await chrome.storage.session.get(PolicyManager.ALLOC_KEY);
        const found = Object.entries(ruleAlloc).find(([, t]) => t === tabId);
        return found ? Number(found[0]) : null;
    }

    /**
     * Blocks script resources on docs.google.com for one tab. Session rules,
     * not dynamic: tabIds are ephemeral and do not survive a restart.
     *
     * @param {number} tabId
     * @param {number} ruleId
     * @returns {Promise<void>}
     */
    static async blockJavaScript(tabId, ruleId) {
        // Ids are freshly allocated, so this should find nothing.
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
        });

        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [
                {
                    id: ruleId,
                    priority: 1,
                    action: { type: 'block' },
                    condition: {
                        resourceTypes: ['script'],
                        urlFilter: '||docs.google.com',
                        tabIds: [tabId],
                    },
                },
            ],
        });

        console.log(`[PolicyManager] JS blocked for tab ${tabId} (session rule ${ruleId})`);
    }

    /**
     * Remove the session JS-blocking rule.
     * @param {number|null|undefined} ruleId
     * @returns {Promise<void>}
     */
    static async restoreJavaScript(ruleId) {
        if (ruleId === null || ruleId === undefined) return;
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
        });
        console.log(`[PolicyManager] JS restored (session rule ${ruleId})`);
    }

    /**
     * Every rule in the band, whatever this worker thinks is allocated. The
     * sweep and the watchdog exist to recover from stale state, so they
     * cannot trust it.
     * @returns {Promise<void>}
     */
    static async sweepAllRules() {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        const staleIds = rules
            .map((r) => r.id)
            .filter((id) => id >= PolicyManager.RULE_ID_MIN && id <= PolicyManager.RULE_ID_MAX);

        if (staleIds.length > 0) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: staleIds });
            console.log(`[PolicyManager] Swept ${staleIds.length} stale session rule(s):`, staleIds);
        }
    }
}
