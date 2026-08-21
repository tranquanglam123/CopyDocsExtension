/**
 * background.js — service worker entry point (spec v3 §2/§4 P2). Wiring
 * and listener registration only; the pipelines and platform adapters live
 * under extraction/ and platform/ — see those files' headers for the
 * watchdog/rule-allocator/startup-sweep design notes.
 */
import { UrlTransformer } from '../core/document-url.js';
import { registerMessageHandler } from '../platform/messaging.js';
import { getActiveTab, onTabRemoved, openNewDocTab } from '../platform/tabs.js';
import { downloadContent } from '../platform/downloads.js';
import { createWatchdogAlarm, onWatchdogAlarm } from '../platform/alarms.js';
import { getExtractionState } from '../platform/storage.js';
import { runPipeline, runWatchdog, startupSweep, handleTabRemoved } from '../extraction/pipeline-runner.js';
import { handleContentReady } from '../extraction/tabnav-pipeline.js';

/** @returns {Promise<object>} */
async function checkTab() {
    const tab = await getActiveTab();
    const { isValid, type } = UrlTransformer.identify(tab.url);
    return {
        isValid,
        type,
        typeLabel: isValid ? UrlTransformer.getTypeLabel(tab.url) : null,
        url: tab.url,
        title: tab.title,
    };
}

// Route incoming messages. The guard filtering out messages without a
// string `action` (e.g. the offscreen document's `{type:'parse'}`) lives in
// platform/messaging.js's `registerMessageHandler`.
async function handleMessage(message, sender, sendResponse) {
    try {
        switch (message.action) {

            case 'checkTab':
                sendResponse({ success: true, data: await checkTab() });
                break;

            case 'startExtraction':
                // The popup may close during navigation, so results always
                // go to session storage regardless of this response.
                try {
                    sendResponse({ success: true, data: await runPipeline() });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;

            case 'contentReady':
                // tabNav path only — content script ships raw HTML for the
                // offscreen parser (extraction/tabnav-pipeline.js).
                await handleContentReady(message.data, sender?.tab?.id);
                sendResponse({ success: true });
                break;

            case 'getExtractionStatus': {
                // Popup polls this to recover after being closed & reopened.
                const { lastExtraction, status, error } = await getExtractionState();
                sendResponse({ success: true, data: lastExtraction, status, error });
                break;
            }

            case 'download':
                try {
                    const downloadId = await downloadContent(
                        message.text,
                        message.filename || 'document.txt',
                        'text/plain'
                    );
                    sendResponse({ success: true, downloadId });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;

            case 'openNewDoc':
                await openNewDocTab();
                sendResponse({ success: true });
                break;

            default:
                sendResponse({ success: false, error: `Unknown action: ${message.action}` });
        }
    } catch (err) {
        console.error('[background]', err);
        sendResponse({ success: false, error: err.message });
    }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

registerMessageHandler(handleMessage);

// Clean up rules/pipeline state if a tab is closed mid-extraction.
onTabRemoved((tabId) => {
    handleTabRemoved(tabId).catch((err) =>
        console.error('[background] tab removal cleanup failed:', err)
    );
});

// Watchdog: recover any pipeline abandoned by a killed service worker.
onWatchdogAlarm(() => {
    runWatchdog().catch((err) => console.error('[background] watchdog run failed:', err));
});
createWatchdogAlarm();

// Startup / install sweep: the browser itself may have restarted
// mid-extraction, in which case even the watchdog alarm never got a
// chance to fire. Sweep unconditionally.
chrome.runtime.onStartup.addListener(() => {
    startupSweep('onStartup').catch((err) => console.error('[background] onStartup sweep failed:', err));
});
chrome.runtime.onInstalled.addListener(() => {
    startupSweep('onInstalled').catch((err) => console.error('[background] onInstalled sweep failed:', err));
});

console.log('[background] Service worker initialized.');
