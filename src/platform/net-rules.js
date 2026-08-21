/**
 * net-rules.js — PolicyManager: DNR rule id allocation, JS block/restore,
 * and the stale-rule sweep (spec v3 §2/§4 P2). Moved from
 * background/service-worker.js.
 *
 * This is part of the machinery that stops a tab being left script-blocked
 * if the service worker dies mid-extraction (spec v3 §10 risk) — treated
 * as move-don't-touch: the method bodies below are unchanged, only their
 * constant sources now come from shared/constants.js.
 */
import { RULE_ID_BAND, SESSION_KEYS } from '../shared/constants.js';

export class PolicyManager {

    /** Session DNR rule id band reserved for this extension (fixes D7's
     *  concern about ANY static block-all ruleset, and scoped for D4's
     *  per-tab allocation). */
    static RULE_ID_MIN = RULE_ID_BAND.MIN;
    static RULE_ID_MAX = RULE_ID_BAND.MAX;

    static ALLOC_KEY = SESSION_KEYS.RULE_ALLOC;

    /**
     * Allocate the lowest free rule id in the 9000-9999 band for a tab
     * (fixes D4 — `BASE_RULE_ID + (tabId % 1000)` collided for tab ids
     * 1000 apart). Persisted immediately so a watchdog/startup sweep can
     * recover it even if the service worker dies before the rule is added.
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
     * Release a previously-allocated rule id. Safe to call more than once
     * or with an id that was never allocated (no-op).
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
     * Add a SESSION-scoped declarativeNetRequest rule that blocks all
     * script resources on docs.google.com for the specified tab.
     *
     * Session rules (not dynamic rules) are required when using tabIds,
     * because tab IDs are ephemeral and don't survive browser restarts.
     *
     * @param {number} tabId
     * @param {number} ruleId
     * @returns {Promise<void>}
     */
    static async blockJavaScript(tabId, ruleId) {
        // Remove any stale rule with this id first (defensive — should
        // never happen since ids are freshly allocated).
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
     * Remove EVERY session DNR rule whose id falls in the 9000-9999 band,
     * regardless of what this service-worker instance thinks is allocated.
     * Used by the startup sweep and the watchdog — the only two callers
     * that must not trust in-memory or even storage.session state, since
     * both exist specifically to recover from state that's gone stale.
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
