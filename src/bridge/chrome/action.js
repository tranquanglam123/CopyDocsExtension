/** chrome.action: the toolbar icon's badge. */

/** @param {string} text  Empty clears it. */
export async function setBadge(text) {
    await chrome.action.setBadgeText({ text });
}
