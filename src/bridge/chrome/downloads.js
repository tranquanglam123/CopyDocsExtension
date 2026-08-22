/**
 * downloads.js — file download helper (spec v3 §2/§4 P2). Moved from
 * background/service-worker.js's `ExtensionController._downloadContent`.
 */

/**
 * Download text content as a file.
 * @param {string} content
 * @param {string} filename
 * @param {string} [mimeType='text/plain']
 * @returns {Promise<number>} Download ID
 */
export function downloadContent(content, filename, mimeType = 'text/plain') {
    return new Promise((resolve, reject) => {
        const blob = new Blob([content], { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
            chrome.downloads.download(
                { url: reader.result, filename, saveAs: true },
                (downloadId) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(downloadId);
                    }
                }
            );
        };
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
    });
}
