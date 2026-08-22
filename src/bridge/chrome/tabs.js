/** Tab lifecycle helpers. */
import { TIMING } from '../../lib/const.js';

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
 * Navigate a tab. Used by the tabnav fallback.
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
 * A thin wrapper only. The cleanup spans netrules and pipeline state, so it
 * lives in run.js's `handleTabRemoved`.
 * @param {(tabId: number) => void} handler
 */
export function onTabRemoved(handler) {
    chrome.tabs.onRemoved.addListener(handler);
}
