/**
 * The only `chrome.scripting.executeScript` call sites. The csFetch tiers
 * need a same-origin fetch inside the tab's own page context; the web path
 * needs content/scan.js run against the live DOM.
 */

/**
 * Inject and run `func(...args)` inside the given tab's page context.
 * @param {number} tabId
 * @param {Function} func   Must be self-contained — it runs in the page,
 *   not this module's closure, so it cannot reference anything outside its
 *   own body except through `args`.
 * @param {Array} args
 * @returns {Promise<any>} The function's return value (structured-cloned),
 *   or `undefined` if injection produced no result.
 */
export async function executeInTab(tabId, func, args) {
    const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
    });
    return injectionResults?.[0]?.result;
}

/**
 * Inject an extension script file; its last expression is the result.
 * @param {number} tabId
 * @param {string} file  Extension-relative path, from CONTENT_SCRIPTS.
 * @returns {Promise<any>}
 */
export async function executeFileInTab(tabId, file) {
    const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        files: [file],
    });
    return injectionResults?.[0]?.result;
}
