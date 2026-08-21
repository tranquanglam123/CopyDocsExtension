/**
 * tabs.js — tab lifecycle helpers (spec v3 §2/§4 P2). Moved from
 * background/service-worker.js's `ExtensionController`.
 */
import { TIMING } from '../shared/constants.js';

/**
 * Get the currently active tab in the focused window.
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');
    return tab;
}

/**
 * Wait for a tab to reach 'complete' status.
 * @param {number} tabId
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function waitForTabLoad(tabId, timeoutMs = TIMING.TAB_LOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('Tab load timed out.'));
        }, timeoutMs);

        function listener(updatedTabId, changeInfo) {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Navigate a tab to a new URL (used by the tabNav fallback pipeline).
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function navigateTab(tabId, url) {
    await chrome.tabs.update(tabId, { url });
}

/**
 * Open a blank Google Doc in a new tab.
 * @returns {Promise<void>}
 */
export async function openNewDocTab() {
    await chrome.tabs.create({
        url: 'https://docs.google.com/document/create',
        active: true,
    });
}

/**
 * Register a tab-removal listener. Kept as a thin wrapper (rather than
 * owning the cleanup logic itself) so this stays a pure platform primitive
 * — the actual cleanup spans both platform/net-rules.js and
 * extraction/pipeline-state.js, and lives in
 * extraction/pipeline-runner.js's `handleTabRemoved`.
 * @param {(tabId: number) => void} handler
 */
export function onTabRemoved(handler) {
    chrome.tabs.onRemoved.addListener(handler);
}
