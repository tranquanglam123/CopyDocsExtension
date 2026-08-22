/** Service worker entry: wiring and listener registration only. */
import { UrlTransformer } from '../lib/url.js';
import { onActionMessage, onStartupOrInstall } from '../bridge/chrome/runtime.js';
import { MSG } from '../bridge/contract.js';
import { getActiveTab, onTabRemoved, openNewDocTab } from '../bridge/chrome/tabs.js';
import { downloadContent } from '../bridge/chrome/downloads.js';
import { createWatchdogAlarm, onWatchdogAlarm } from '../bridge/chrome/alarms.js';
import { getExtractionState } from '../bridge/chrome/storage.js';
import { runPipeline, runWatchdog, startupSweep, handleTabRemoved } from './extract/run.js';
import { handleContentReady } from './extract/via-tabnav.js';

// AppError's code/params are duck-typed through so the popup can translate;
// a plain Error degrades to its raw message.
const errorResponse = (err) => ({ success: false, error: err.message, code: typeof err.code === 'string' ? err.code : undefined, params: err.params });
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

// registerMessageHandler drops anything without a string `action`, so the
// offscreen document's `{type:'parse'}` never reaches this switch.
async function handleMessage(message, sender, sendResponse) {
    try {
        switch (message.action) {

            case MSG.CHECK_TAB:
                sendResponse({ success: true, data: await checkTab() });
                break;

            case MSG.START_EXTRACTION:
                // The popup may close during navigation, so results always
                // go to session storage regardless of this response.
                try {
                    sendResponse({ success: true, data: await runPipeline() });
                } catch (err) {
                    sendResponse(errorResponse(err));
                }
                break;

            case MSG.CONTENT_READY:
                // tabNav path only — content script ships raw HTML for the
                // offscreen parser (background/extract/via-tabnav.js).
                await handleContentReady(message.data, sender?.tab?.id);
                sendResponse({ success: true });
                break;

            case MSG.EXTRACTION_STATUS: {
                // Popup polls this to recover after being closed & reopened.
                const { lastExtraction, status, error } = await getExtractionState();
                sendResponse({ success: true, data: lastExtraction, status, error });
                break;
            }

            case MSG.DOWNLOAD:
                try {
                    const downloadId = await downloadContent(
                        message.text,
                        message.filename || 'document.txt',
                        'text/plain'
                    );
                    sendResponse({ success: true, downloadId });
                } catch (err) {
                    sendResponse(errorResponse(err));
                }
                break;

            case MSG.OPEN_NEW_DOC:
                await openNewDocTab();
                sendResponse({ success: true });
                break;

            default:
                sendResponse({ success: false, error: `Unknown action: ${message.action}` });
        }
    } catch (err) {
        console.error('[background]', err);
        sendResponse(errorResponse(err));
    }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

onActionMessage(handleMessage);

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

// The browser may have restarted mid-extraction, in which case even the
// watchdog alarm never got a chance to fire. Sweep unconditionally.
onStartupOrInstall((reason) => {
    startupSweep(reason).catch((err) => console.error(`[background] ${reason} sweep failed:`, err));
});

console.log('[background] Service worker initialized.');
