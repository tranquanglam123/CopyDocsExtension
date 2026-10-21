/**
 * chrome.runtime native messaging. connectNative rather than
 * sendNativeMessage: an open port keeps the service worker alive while the
 * host works, and an install must not be cut off halfway.
 */

/**
 * One request, one reply.
 * @param {string} host  Native messaging host name.
 * @param {object} message
 * @param {number} timeoutMs
 * @returns {Promise<object>} The host's reply. Rejects when the host is not
 *   registered, exits without answering, or takes longer than `timeoutMs`.
 */
export function callNativeHost(host, message, timeoutMs) {
    return new Promise((resolve, reject) => {
        let port;
        try {
            port = chrome.runtime.connectNative(host);
        } catch (err) {
            reject(err);
            return;
        }
        let settled = false;
        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { port.disconnect(); } catch { /* already gone */ }
            settle(value);
        };
        const timer = setTimeout(() => finish(reject, new Error(`${host} did not answer in time`)), timeoutMs);
        port.onMessage.addListener((reply) => finish(resolve, reply));
        port.onDisconnect.addListener(() => {
            finish(reject, new Error(chrome.runtime.lastError?.message || `${host} exited without answering`));
        });
        port.postMessage(message);
    });
}
