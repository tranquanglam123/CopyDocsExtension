/**
 * The only `chrome.scripting.executeScript` call site. Both csFetch tiers
 * need a same-origin fetch inside the tab's own page context.
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
