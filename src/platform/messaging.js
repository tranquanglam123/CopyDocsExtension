/**
 * messaging.js — chrome.runtime.onMessage registration (spec v3 §2/§4 P2).
 * Moved from background/service-worker.js's `ExtensionController.init`.
 *
 * chrome.runtime.sendMessage broadcasts to every extension context, so this
 * listener also sees the `{ type: 'parse' }` messages aimed at the
 * offscreen document. Answering those would race the offscreen parser's
 * real reply and break parsing, so anything without a string `action` is
 * left alone (return undefined = "not mine").
 */

/**
 * @param {(message: object, sender: chrome.runtime.MessageSender, sendResponse: Function) => void} handleMessage
 */
export function registerMessageHandler(handleMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.action !== 'string') return undefined;
        handleMessage(message, sender, sendResponse);
        return true; // keep channel open for async
    });
}
