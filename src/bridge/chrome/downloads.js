/** chrome.downloads wrapper. */

/**
 * @param {string} url       A data: URL.
 * @param {string} filename
 * @returns {Promise<number>} Download ID
 */
export function downloadDataUrl(url, filename) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(downloadId);
            }
        });
    });
}

/**
 * @param {string} content
 * @param {string} filename
 * @param {string} [mimeType='text/plain']
 * @returns {Promise<number>} Download ID
 */
export function downloadContent(content, filename, mimeType = 'text/plain') {
    return new Promise((resolve, reject) => {
        const blob = new Blob([content], { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => downloadDataUrl(reader.result, filename).then(resolve, reject);
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
    });
}
