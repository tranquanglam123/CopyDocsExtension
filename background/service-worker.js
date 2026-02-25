/**
 * Service Worker — ExtensionController + PolicyManager
 *
 * Orchestrates the full extraction pipeline:
 *   1. Validate URL  →  2. Block JS  →  3. Navigate  →  4. Extract  →  5. Restore JS
 *
 * DESIGN NOTES (Bug Fix Round):
 * - Uses updateSessionRules() (not Dynamic) so tabIds is supported.
 * - Pipeline stores results in chrome.storage.session so the popup can
 *   recover data if it closes during tab navigation.
 * - Content script is auto-injected by manifest content_scripts — no
 *   manual executeScript call needed.
 */

import { UrlTransformer } from '../lib/url-transformer.js';


// ─── PolicyManager ──────────────────────────────────────────────────────────

class PolicyManager {

    /** Base rule ID — we add (tabId % 1000) to make it unique per tab */
    static BASE_RULE_ID = 9000;

    /**
     * Get a unique rule ID for a given tab.
     * @param {number} tabId
     * @returns {number}
     */
    static ruleIdForTab(tabId) {
        return PolicyManager.BASE_RULE_ID + (tabId % 1000);
    }

    /**
     * Add a SESSION-scoped declarativeNetRequest rule that blocks all
     * script resources on docs.google.com for the specified tab.
     *
     * Session rules (not dynamic rules) are required when using tabIds,
     * because tab IDs are ephemeral and don't survive browser restarts.
     *
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    static async blockJavaScript(tabId) {
        const ruleId = PolicyManager.ruleIdForTab(tabId);

        // Remove any existing rule for this tab first
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
        });

        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [
                {
                    id: ruleId,
                    priority: 1,
                    action: { type: 'block' },
                    condition: {
                        resourceTypes: ['script'],
                        urlFilter: '||docs.google.com',
                        tabIds: [tabId],
                    },
                },
            ],
        });

        console.log(`[PolicyManager] JS blocked for tab ${tabId} (session rule ${ruleId})`);
    }

    /**
     * Remove the session JS-blocking rule for a tab.
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    static async restoreJavaScript(tabId) {
        const ruleId = PolicyManager.ruleIdForTab(tabId);

        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
        });

        console.log(`[PolicyManager] JS restored for tab ${tabId}`);
    }
}

// ─── ExtensionController ────────────────────────────────────────────────────

class ExtensionController {

    /**
     * Pending extraction resolver.
     * When the content script sends 'contentReady', we resolve this promise
     * so runPipeline() can continue.
     * @type {{ resolve: Function, reject: Function } | null}
     */
    static _pendingExtraction = null;

    /**
     * Initialize event listeners.
     */
    static init() {
        // Listen for messages from popup AND content scripts
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            ExtensionController.handleMessage(message, sender, sendResponse);
            return true; // keep channel open for async
        });

        // Clean up rules if a tab is closed mid-extraction
        chrome.tabs.onRemoved.addListener((tabId) => {
            PolicyManager.restoreJavaScript(tabId).catch(() => { });
        });

        console.log('[ExtensionController] Service worker initialized.');
    }

    /**
     * Route incoming messages.
     */
    static async handleMessage(message, _sender, sendResponse) {
        try {
            switch (message.action) {

                case 'checkTab': {
                    const tab = await ExtensionController.getActiveTab();
                    const { isValid, type } = UrlTransformer.identify(tab.url);
                    sendResponse({
                        success: true,
                        data: {
                            isValid,
                            type,
                            typeLabel: isValid ? UrlTransformer.getTypeLabel(tab.url) : null,
                            url: tab.url,
                            title: tab.title,
                        },
                    });
                    break;
                }

                case 'startExtraction': {
                    // Run the pipeline. The popup may close during navigation,
                    // so we store results in session storage regardless.
                    const result = await ExtensionController.runPipeline();
                    // If the popup is still open, it gets the response here:
                    sendResponse({ success: true, data: result });
                    break;
                }

                case 'contentReady': {
                    // Content script auto-sent its extracted data.
                    // Store in session storage (popup will poll for this).
                    const data = message.data;
                    await chrome.storage.session.set({
                        lastExtraction: data,
                        extractionStatus: 'complete',
                    });

                    // If runPipeline() is waiting for this, resolve it.
                    if (ExtensionController._pendingExtraction) {
                        ExtensionController._pendingExtraction.resolve(data);
                        ExtensionController._pendingExtraction = null;
                    }

                    sendResponse({ success: true });
                    break;
                }

                case 'getExtractionStatus': {
                    // Popup polls this to recover after being closed & re-opened.
                    const stored = await chrome.storage.session.get([
                        'lastExtraction',
                        'extractionStatus',
                    ]);
                    sendResponse({
                        success: true,
                        data: stored.lastExtraction || null,
                        status: stored.extractionStatus || 'idle',
                    });
                    break;
                }

                case 'download': {
                    // Plain text download
                    try {
                        const downloadId = await ExtensionController._downloadContent(
                            message.text,
                            message.filename || 'document.txt',
                            'text/plain'
                        );
                        sendResponse({ success: true, downloadId });
                    } catch (err) {
                        sendResponse({ success: false, error: err.message });
                    }
                    break;
                }

                case 'openNewDoc': {
                    // Open a blank Google Doc in a new tab
                    await chrome.tabs.create({
                        url: 'https://docs.google.com/document/create',
                        active: true,
                    });
                    sendResponse({ success: true });
                    break;
                }

                default:
                    sendResponse({ success: false, error: `Unknown action: ${message.action}` });
            }
        } catch (err) {
            console.error('[ExtensionController]', err);
            sendResponse({ success: false, error: err.message });
        }
    }

    /**
     * Download text content as a file.
     * @param {string} content
     * @param {string} filename
     * @param {string} [mimeType='text/plain']
     * @returns {Promise<number>} Download ID
     */
    static _downloadContent(content, filename, mimeType = 'text/plain') {
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

    /**
     * Full extraction pipeline.
     * @returns {Promise<{ title: string, text: string, charCount: number }>}
     */
    static async runPipeline() {
        // Mark extraction as in-progress
        await chrome.storage.session.set({
            extractionStatus: 'running',
            lastExtraction: null,
        });

        // 1. Get active tab
        const tab = await ExtensionController.getActiveTab();
        const tabId = tab.id;

        if (!UrlTransformer.isGoogleDoc(tab.url)) {
            await chrome.storage.session.set({ extractionStatus: 'error' });
            throw new Error('Active tab is not a Google Docs/Sheets/Slides page.');
        }

        // 2. Build mobilebasic URL
        const mobileUrl = UrlTransformer.toMobileBasic(tab.url);
        if (!mobileUrl) {
            await chrome.storage.session.set({ extractionStatus: 'error' });
            throw new Error('Failed to build mobilebasic URL.');
        }

        // 3. Block JavaScript on this tab (Session rules — supports tabIds)
        await PolicyManager.blockJavaScript(tabId);

        try {
            // 4. Create a promise that the content script will resolve
            //    when it sends 'contentReady' after auto-injection.
            const contentPromise = new Promise((resolve, reject) => {
                ExtensionController._pendingExtraction = { resolve, reject };

                // Timeout after 20 seconds
                setTimeout(() => {
                    if (ExtensionController._pendingExtraction) {
                        ExtensionController._pendingExtraction = null;
                        reject(new Error('Content extraction timed out (20s). The page may not have loaded correctly.'));
                    }
                }, 20000);
            });

            // 5. Navigate the tab to mobilebasic
            //    (This will likely close the popup — that's OK, results go to session storage)
            await chrome.tabs.update(tabId, { url: mobileUrl });

            // 6. Wait for the page to finish loading
            await ExtensionController.waitForTabLoad(tabId);

            // 7. Wait for content script to send extracted data
            //    The content script is auto-injected by manifest content_scripts
            //    and sends 'contentReady' after a short delay.
            const extractedData = await contentPromise;

            // 8. Store the final result (already done in contentReady handler, but ensure)
            await chrome.storage.session.set({
                lastExtraction: extractedData,
                extractionStatus: 'complete',
            });

            return extractedData;

        } finally {
            // 9. Always restore JavaScript
            await PolicyManager.restoreJavaScript(tabId);
        }
    }

    /**
     * Get the currently active tab in the focused window.
     * @returns {Promise<chrome.tabs.Tab>}
     */
    static async getActiveTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error('No active tab found.');
        return tab;
    }

    /**
     * Wait for a tab to reach 'complete' status.
     * @param {number} tabId
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<void>}
     */
    static waitForTabLoad(tabId, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error('Tab load timed out.'));
            }, timeoutMs);

            function listener(updatedTabId, changeInfo) {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    clearTimeout(timeout);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            }

            chrome.tabs.onUpdated.addListener(listener);
        });
    }

    /**
     * Simple delay helper.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    static delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

ExtensionController.init();
