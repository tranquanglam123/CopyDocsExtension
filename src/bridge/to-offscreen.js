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

/**
 * @param {string} base64    The file's bytes.
 * @param {string} fileType  'pdf' | 'zip'
 * @returns {Promise<{title: string, text: string, bodyHtml: string, warnings: string[], ole?: object[]}>}
 *   `ole`: a .docx's MathType equations, kept whole for the .docx export.
 */
export async function parseFile(base64, fileType) {
    await ensureDocument();

    const response = await chrome.runtime.sendMessage({ type: MSG.PARSE_FILE, base64, fileType });
    if (!response?.ok) {
        throw new Error(response?.error || 'Offscreen file parse failed.');
    }

    scheduleClose();
    return response.data;
}
