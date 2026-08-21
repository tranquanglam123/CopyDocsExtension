/**
 * popup-exports.js — the popup's export operations: rich clipboard copy,
 * .docx generation + download, and .txt download.
 *
 * Formerly `lib/export-service.js`. That file was dead code (spec v3 §1):
 * nothing imported it, and entry/popup.js reimplemented the same clipboard
 * and download logic inline instead — but with a two-tier fallback chain
 * (ClipboardItem → writeText → execCommand) and a single ClipboardItem that
 * carries *both* `text/html` and `text/plain`, which the old ExportService
 * never did (it only ever wrote plain text). Per the spec v3 §7 file map
 * this is where the two get merged into the one implementation; the
 * popup-only inline version is the one that survives because it's the one
 * that's actually correct — the old ExportService.copyToClipboard would
 * have pasted into Google Docs as unformatted text.
 *
 * DOCX generation runs HERE (in the popup), not in the service worker,
 * because DocxGenerator needs DOM APIs (DOMParser, Node, etc.) that don't
 * exist in a service worker.
 */

import { DocxGenerator } from './docx-generator.js';
import { I18n } from '../shared/i18n.js';

// ── Copy with formatting ─────────────────────────────────────────

/**
 * Write both `text/html` and `text/plain` into the same ClipboardItem —
 * this is what makes pasting into Google Docs / Word preserve formatting
 * instead of landing as plain text. Falls back progressively if the rich
 * write isn't available in this context.
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
 * @returns {Promise<number>} the chrome.downloads download id.
 */
export async function downloadDocx(bodyHtml, title, filename) {
    const blob = DocxGenerator.generate(bodyHtml, title);
    const dataUrl = await blobToDataUrl(blob);

    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            { url: dataUrl, filename, saveAs: true },
            (downloadId) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(downloadId);
                }
            }
        );
    });
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
    const resp = await chrome.runtime.sendMessage({
        action: 'download',
        text,
        filename,
        mimeType,
    });
    if (!resp?.success) {
        throw new Error(resp?.error || I18n.t('error.downloadFailed'));
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
