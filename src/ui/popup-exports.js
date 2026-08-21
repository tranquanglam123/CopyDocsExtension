/**
 * ExportService — Handles clipboard copy and file download of extracted content.
 */
export class ExportService {

    /**
     * Copy text to the system clipboard.
     * Must be called from a context with clipboard access (popup or content script
     * triggered by a user gesture).
     * @param {string} text  The plain-text content to copy.
     * @returns {Promise<boolean>}  true on success.
     */
    static async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.error('[ExportService] Clipboard write failed:', err);
            // Fallback: execCommand (works in more contexts)
            return ExportService._fallbackCopy(text);
        }
    }

    /**
     * Fallback copy using a temporary textarea + execCommand.
     * @private
     */
    static _fallbackCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    }

    /**
     * Download text content as a file via the Chrome Downloads API.
     * @param {string} text      The text content.
     * @param {string} filename  Desired filename (e.g. "MyDoc.txt").
     * @param {string} [mimeType='text/plain']  MIME type.
     * @returns {Promise<number>}  Download ID from Chrome API.
     */
    static async downloadAsFile(text, filename = 'document.txt', mimeType = 'text/plain') {
        const blob = new Blob([text], { type: mimeType });
        const dataUrl = await ExportService._blobToDataUrl(blob);

        return new Promise((resolve, reject) => {
            chrome.downloads.download(
                {
                    url: dataUrl,
                    filename: filename,
                    saveAs: true,
                },
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

    /**
     * Convert a Blob to a data URL.
     * @private
     */
    static _blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}
