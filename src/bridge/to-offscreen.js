/** The service worker's only way to reach the offscreen document. */

import { MSG } from './contract.js';
import { ensureDocument, scheduleClose } from './chrome/offscreen.js';

/**
 * @param {string} html      Raw document HTML.
 * @param {string} docType   'docs' | 'sheets' | 'slides'
 * @returns {Promise<object>} { title, text, html, bodyHtml, charCount, meta }
 */
export async function parse(html, docType) {
    await ensureDocument();

    const response = await chrome.runtime.sendMessage({ type: MSG.PARSE, html, docType });
    if (!response?.ok) {
        throw new Error(response?.error || 'Offscreen parse failed.');
    }

    scheduleClose();
    return response.data;
}
