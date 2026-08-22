/**
 * Every message that crosses a realm boundary, declared once.
 *
 * `chrome.runtime.sendMessage` broadcasts to every extension context, so the
 * two directions are keyed differently: requests to the background carry
 * `action`, the request to the offscreen document carries `type`. Each
 * listener ignores the other's shape.
 *
 * To the background — `{ action, ...payload }`, reply `{ success, ... }`:
 *
 *   CHECK_TAB           {}                        → { success, data: { isValid, type, typeLabel, url, title, docId } }
 *   START_EXTRACTION    {}                        → { success, data } | { success:false, error, code?, params? }
 *   EXTRACTION_STATUS   {}                        → { success, data, status, error }
 *   DOWNLOAD            { text, filename, mimeType } → { success, downloadId }
 *   OPEN_NEW_DOC        {}                        → { success }
 *   RESET               {}                        → { success }
 *   CONTENT_READY       { data: { rawHtml, title, url, docType } } → { success }
 *
 * To the offscreen document — `{ type, ...payload }`:
 *
 *   PARSE               { html, docType }         → { ok:true, data } | { ok:false, error }
 */

/** Message names. `content/main.js` repeats CONTENT_READY as a literal —
 *  content scripts are not modules under MV3 and cannot import. */
export const MSG = Object.freeze({
    CHECK_TAB: 'checkTab',
    START_EXTRACTION: 'startExtraction',
    EXTRACTION_STATUS: 'getExtractionStatus',
    DOWNLOAD: 'download',
    OPEN_NEW_DOC: 'openNewDoc',
    RESET: 'resetExtraction',
    CONTENT_READY: 'contentReady',
    PARSE: 'parse',
});
