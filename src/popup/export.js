/**
 * The popup's exports: rich clipboard copy, .docx, .txt. All here rather
 * than in the worker because DocxGenerator and the clipboard need a DOM.
 */

import { DocxGenerator } from './docx.js';
import { I18n } from '../lib/i18n/index.js';
import { downloadDataUrl, downloadUrl } from '../bridge/chrome/downloads.js';
import { downloadText } from '../bridge/to-background.js';

// ── Copy with formatting ─────────────────────────────────────────

/**
 * One ClipboardItem carrying both flavours — plain text alone pastes into
 * Google Docs unformatted. Falls back if the rich write is unavailable.
 * @param {string} html
 * @param {string} text
 * @returns {Promise<'rich'|'plain'|'fallback'>} which path actually wrote the clipboard.
 */
export async function copyRichContent(html, text) {
    try {
        const htmlBlob = new Blob([html], { type: 'text/html' });
        const textBlob = new Blob([text], { type: 'text/plain' });

        await navigator.clipboard.write([
            new ClipboardItem({
                'text/html': htmlBlob,
                'text/plain': textBlob,
            }),
        ]);
        return 'rich';
    } catch (err) {
        console.warn('[Popup] ClipboardItem failed, using text fallback:', err);
        try {
            await navigator.clipboard.writeText(text);
            return 'plain';
        } catch {
            legacyCopy(text);
            return 'fallback';
        }
    }
}

function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
}

// ── Download .docx (Office 2007+) ──────────────────────────────────

/**
 * Generate a .docx from bodyHtml and trigger a save-as download.
 * @param {string} bodyHtml
 * @param {string} title
 * @param {string} filename
 * @param {object[]} [ole]  MathType equations bodyHtml marks with `data-ole`.
 * @returns {Promise<number>} the chrome.downloads download id.
 */
export async function downloadDocx(bodyHtml, title, filename, ole = []) {
    const blob = DocxGenerator.generate(bodyHtml, title, { ole });
    return downloadDataUrl(await blobToDataUrl(blob), filename);
}

// ── Download .txt ────────────────────────────────────────────────

/**
 * Download plain text. Routed through the service worker (unlike .docx,
 * which downloads directly from the popup) — this mirrors the background's
 * existing 'download' message handler rather than duplicating it.
 * @param {string} text
 * @param {string} filename
 * @param {string} [mimeType='text/plain']
 */
export async function downloadTxt(text, filename, mimeType = 'text/plain') {
    const resp = await downloadText(text, filename, mimeType);
    if (!resp?.success) {
        throw new Error(resp?.error || I18n.t('error.downloadFailed'));
    }
}

// ── Download original files ─────────────────────────────────────

/**
 * The files a web page embedded, straight from their URLs. Chrome's own
 * download carries the cookies, so this works where the fetch could not.
 * @param {Array<{url: string, name: string|null}>} files
 */
export async function downloadOriginals(files) {
    for (const file of files) {
        const name = file.name ? file.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') : null;
        await downloadUrl(file.url, name);
    }
}

// ── Utils ────────────────────────────────────────────────────────

export function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 100);
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
    });
}
