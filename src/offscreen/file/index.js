/** A fetched file's bytes to the body-HTML shape, by its sniffed type. */
import { parsePdf } from './pdf.js';
import { parseDocx } from './docx.js';

/**
 * @param {string} base64
 * @param {string} fileType  'pdf' | 'zip'
 * @returns {Promise<{title: string, text: string, bodyHtml: string, warnings: string[]}>}
 */
export async function parseFile(base64, fileType) {
    if (typeof base64 !== 'string' || !base64) {
        throw new Error('parseFile requires the file as a non-empty base64 string.');
    }
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (fileType === 'pdf') return parsePdf(bytes);
    if (fileType === 'zip') return parseDocx(bytes);
    throw new Error(`No parser for file type "${fileType}".`);
}
