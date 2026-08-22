/**
 * chrome.runtime listeners. sendMessage broadcasts to every extension
 * context, so each registration below ignores messages shaped for the other:
 * requests to the background carry `action`, the parse request carries `type`.
 */
import { MSG } from '../contract.js';

/**
 * @param {(message: object, sender: chrome.runtime.MessageSender, sendResponse: Function) => void} handleMessage
 */
export function onActionMessage(handleMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.action !== 'string') return undefined;
        handleMessage(message, sender, sendResponse);
        return true; // keep channel open for async
    });
}

/**
 * @param {(html: string, docType: string|undefined) => Promise<object>} parseHtml
 */
export function onParseRequest(parseHtml) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.type !== MSG.PARSE) return undefined;

        (async () => {
            try {
                sendResponse({ ok: true, data: await parseHtml(message.html, message.docType) });
            } catch (err) {
                console.error('[offscreen] parse failed:', err);
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();

        return true; // keep channel open for async
    });
}

/** Fires when the browser starts or the extension is installed/updated. */
export function onStartupOrInstall(handler) {
    chrome.runtime.onStartup.addListener(() => handler('onStartup'));
    chrome.runtime.onInstalled.addListener(() => handler('onInstalled'));
}
