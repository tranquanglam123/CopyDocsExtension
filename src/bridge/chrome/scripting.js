/**
 * scripting.js — the only place `chrome.scripting.executeScript` is called
 * from (spec v3 §2). `extraction/http-transport.js`'s T2 `csFetch` and
 * `extraction/binary-transport.js`'s T2 `csFetchBinary` both need to run a
 * same-origin fetch inside a tab's own page context, but `src/extraction/`
 * must stay chrome-free, so the actual `chrome.scripting` call lives here
 * and they call through this thin wrapper instead.
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
