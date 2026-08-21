/**
 * Service Worker — ExtensionController + PolicyManager + PipelineState
 *
 * Orchestrates the full extraction pipeline. Three transports exist:
 *
 *   docs   (fetch)    1. Validate URL → 2. lib/transport.js fetchDocHtml()
 *                     (T1 swFetch, then T2 csFetch) → 3. Offscreen parse →
 *                     4. Store result — no tab touched, no DNR rule.
 *   sheets (swFetch)  1. Validate URL → 2. fetch({credentials:'include'}) →
 *                     3. Parse CSV → 4. Build HTML — no tab touched, no DNR rule.
 *   docs   (tabNav)   LAST-RESORT FALLBACK ONLY, used when every fetch tier
 *                     fails: 1. Validate URL → 2. Allocate rule id →
 *                     3. Block JS → 4. Navigate → 5. Extract (content
 *                     script) → 6. Restore JS.
 *
 * BUG FIX (spec §3.2 T1/T2 pulled forward from P3): `docs` used to be
 * `tabNav`-only. In the real browser, blocking scripts on docs.google.com
 * and navigating to `/mobilebasic` now redirects to
 * support.google.com/accounts/answer/32050 ("clear cache and cookies"),
 * because blocking scripts breaks Google's own cookie/consent bootstrap.
 * The tab was hijacked for nothing and extraction hung until the 20s
 * timeout. `/mobilebasic` itself is fine — a plain fetch reaches it
 * directly, no navigation required. `tabNav` now runs only if fetching
 * fails outright (see `runFetchHtmlPipeline`/`runTabNavPipeline` below).
 *
 * DESIGN NOTES (P1 — spec §6, D3/D4):
 * - `_pendingExtraction` (in-memory) is still used to bridge the content
 *   script's 'contentReady' message back into runPipeline() while the SW
 *   is alive — but it is no longer the ONLY guarantee that a tab's JS gets
 *   restored. `chrome.storage.session.pipeline` is written BEFORE every
 *   side effect (rule add, tab navigate) and is the source of truth a
 *   restarted service worker (or the watchdog alarm) reads to recover.
 * - Rule IDs are allocated from `chrome.storage.session.ruleAlloc`
 *   (lowest free id in 9000-9999), not derived from `tabId % 1000` (D4 —
 *   the old scheme collided for tab ids 1000 apart).
 * - `chrome.alarms` fires a watchdog every minute; any pipeline older than
 *   60s is treated as abandoned (SW was almost certainly killed mid-flight)
 *   and is force-recovered: DNR rule removed, rule id released, pipeline
 *   cleared, status set to 'error'.
 * - `onStartup`/`onInstalled` sweep every session DNR rule in the 9000-9999
 *   band and clear `ruleAlloc`/`pipeline` — belt-and-suspenders for the
 *   case where the browser itself restarted mid-extraction.
 * - Content script is auto-injected by manifest content_scripts (docs/tabNav
 *   path only) — no manual executeScript call needed.
 */

import { UrlTransformer } from '../core/document-url.js';
import { parseCsv, csvToHtml } from '../core/csv-to-html.js';
import { fetchDocHtml } from '../extraction/http-transport.js';
import { ImageEmbedder } from '../extraction/image-embedder.js';


// ─── PipelineState ──────────────────────────────────────────────────────────
// Persisted state machine for the in-flight extraction (fixes D3).
// Shape: { phase, tabId, ruleId, startedAt, docId }

class PipelineState {

    static STORAGE_KEY = 'pipeline';

    /**
     * Merge-write partial pipeline state. Callers write BEFORE every side
     * effect (rule add, tab navigate, fetch) so a killed service worker
     * always leaves behind an accurate breadcrumb for the watchdog.
     * @param {object} partial
     * @returns {Promise<object>} The full pipeline object after the merge.
     */
    static async write(partial) {
        const existing = await PipelineState.get();
        const next = { ...(existing || {}), ...partial };
        await chrome.storage.session.set({ [PipelineState.STORAGE_KEY]: next });
        return next;
    }

    /**
     * @returns {Promise<object|null>}
     */
    static async get() {
        const stored = await chrome.storage.session.get(PipelineState.STORAGE_KEY);
        return stored[PipelineState.STORAGE_KEY] || null;
    }

    /**
     * @returns {Promise<void>}
     */
    static async clear() {
        await chrome.storage.session.remove(PipelineState.STORAGE_KEY);
    }
}

// ─── PolicyManager ──────────────────────────────────────────────────────────

class PolicyManager {

    /** Session DNR rule id band reserved for this extension (fixes D7's
     *  concern about ANY static block-all ruleset, and scoped for D4's
     *  per-tab allocation). */
    static RULE_ID_MIN = 9000;
    static RULE_ID_MAX = 9999;

    static ALLOC_KEY = 'ruleAlloc';

    /**
     * Allocate the lowest free rule id in the 9000-9999 band for a tab
     * (fixes D4 — `BASE_RULE_ID + (tabId % 1000)` collided for tab ids
     * 1000 apart). Persisted immediately so a watchdog/startup sweep can
     * recover it even if the service worker dies before the rule is added.
     * @param {number} tabId
     * @returns {Promise<number>} The allocated rule id.
     */
    static async allocateRuleId(tabId) {
        const { [PolicyManager.ALLOC_KEY]: ruleAlloc = {} } =
            await chrome.storage.session.get(PolicyManager.ALLOC_KEY);

        const used = new Set(Object.keys(ruleAlloc).map(Number));
        for (let id = PolicyManager.RULE_ID_MIN; id <= PolicyManager.RULE_ID_MAX; id++) {
            if (!used.has(id)) {
                ruleAlloc[id] = tabId;
                await chrome.storage.session.set({ [PolicyManager.ALLOC_KEY]: ruleAlloc });
                return id;
            }
        }

        throw new Error(
            `Rule ID band exhausted (${PolicyManager.RULE_ID_MIN}-${PolicyManager.RULE_ID_MAX}) — ` +
            'too many concurrent extractions in flight. Close some tabs and try again.'
        );
    }

    /**
     * Release a previously-allocated rule id. Safe to call more than once
     * or with an id that was never allocated (no-op).
     * @param {number|null|undefined} ruleId
     * @returns {Promise<void>}
     */
    static async releaseRuleId(ruleId) {
        if (ruleId === null || ruleId === undefined) return;
        const { [PolicyManager.ALLOC_KEY]: ruleAlloc = {} } =
            await chrome.storage.session.get(PolicyManager.ALLOC_KEY);
        if (ruleAlloc[ruleId] !== undefined) {
            delete ruleAlloc[ruleId];
            await chrome.storage.session.set({ [PolicyManager.ALLOC_KEY]: ruleAlloc });
        }
    }

    /**
     * Find the rule id (if any) allocated to a given tab.
     * @param {number} tabId
     * @returns {Promise<number|null>}
     */
    static async ruleIdForTab(tabId) {
        const { [PolicyManager.ALLOC_KEY]: ruleAlloc = {} } =
            await chrome.storage.session.get(PolicyManager.ALLOC_KEY);
        const found = Object.entries(ruleAlloc).find(([, t]) => t === tabId);
        return found ? Number(found[0]) : null;
    }

    /**
     * Add a SESSION-scoped declarativeNetRequest rule that blocks all
     * script resources on docs.google.com for the specified tab.
     *
     * Session rules (not dynamic rules) are required when using tabIds,
     * because tab IDs are ephemeral and don't survive browser restarts.
     *
     * @param {number} tabId
     * @param {number} ruleId
     * @returns {Promise<void>}
     */
    static async blockJavaScript(tabId, ruleId) {
        // Remove any stale rule with this id first (defensive — should
        // never happen since ids are freshly allocated).
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
     * Remove the session JS-blocking rule.
     * @param {number|null|undefined} ruleId
     * @returns {Promise<void>}
     */
    static async restoreJavaScript(ruleId) {
        if (ruleId === null || ruleId === undefined) return;
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
        });
        console.log(`[PolicyManager] JS restored (session rule ${ruleId})`);
    }

    /**
     * Remove EVERY session DNR rule whose id falls in the 9000-9999 band,
     * regardless of what this service-worker instance thinks is allocated.
     * Used by the startup sweep and the watchdog — the only two callers
     * that must not trust in-memory or even storage.session state, since
     * both exist specifically to recover from state that's gone stale.
     * @returns {Promise<void>}
     */
    static async sweepAllRules() {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        const staleIds = rules
            .map((r) => r.id)
            .filter((id) => id >= PolicyManager.RULE_ID_MIN && id <= PolicyManager.RULE_ID_MAX);

        if (staleIds.length > 0) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: staleIds });
            console.log(`[PolicyManager] Swept ${staleIds.length} stale session rule(s):`, staleIds);
        }
    }
}

// ─── ImageEmbedSettings ─────────────────────────────────────────────────────
// The "Embed images" popup toggle (spec §4.4). Lives in chrome.storage.local
// (not .session) so it persists like a normal setting, across browser
// restarts, not just across one extraction. Default ON: whether Google Docs
// actually accepts `data:` URI images on paste is unverified (spec §8 Q1),
// so ON is the useful-by-default guess and the toggle is the escape hatch
// if that guess turns out to be wrong for a given user/session.

class ImageEmbedSettings {

    static STORAGE_KEY = 'embedImagesEnabled';

    /** @returns {Promise<boolean>} */
    static async isEnabled() {
        const stored = await chrome.storage.local.get(ImageEmbedSettings.STORAGE_KEY);
        const value = stored[ImageEmbedSettings.STORAGE_KEY];
        return value === undefined ? true : !!value;
    }
}

// ─── HtmlDocument ───────────────────────────────────────────────────────────
// Minimal string-templated HTML wrapper for the swFetch (Sheets) pipeline.
// The service worker has no DOM, so this is pure string interpolation —
// deliberately mirrors DOMScanner.wrapAsDocument() in content-script.js.

class HtmlDocument {

    /**
     * @param {string} bodyHtml
     * @param {string} title
     * @returns {string}
     */
    static wrap(bodyHtml, title) {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${HtmlDocument.escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; max-width: 800px; margin: 20px auto; color: #222; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  td, th { border: 1px solid #ccc; padding: 6px 8px; }
  th { background: #f5f5f5; font-weight: bold; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
    }

    /** @param {string} str @returns {string} */
    static escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}

// ─── OffscreenManager ───────────────────────────────────────────────────────
// Bridge to offscreen/parser.js (spec §4.1). The service worker has no DOM,
// so all HTML parsing happens in a single offscreen document, which loads the
// markup into a sandboxed iframe and resolves formatting through a real CSS
// cascade (the D2 fix).

class OffscreenManager {

    static DOCUMENT_URL = 'src/entry/offscreen.html';

    /** Close the document after this much idle time. */
    static IDLE_CLOSE_MS = 30_000;

    /** @type {number|null} */
    static _closeTimer = null;

    /**
     * Create the offscreen document if it isn't already open. Only one may
     * exist at a time, so this is idempotent by design.
     * @returns {Promise<void>}
     */
    static async ensure() {
        if (await chrome.offscreen.hasDocument()) return;

        try {
            await chrome.offscreen.createDocument({
                url: OffscreenManager.DOCUMENT_URL,
                reasons: ['DOM_PARSER'],
                justification:
                    'Parse fetched Google Docs HTML off the visible DOM so formatting can be ' +
                    'resolved through a real CSS cascade. No page scripts execute.',
            });
        } catch (err) {
            // A concurrent call may have won the race between hasDocument()
            // and createDocument() — that is success, not failure.
            if (!/single offscreen/i.test(err?.message || '')) throw err;
        }
    }

    /**
     * Parse raw HTML into the extraction result contract.
     * @param {string} html      Raw document HTML.
     * @param {string} docType   'docs' | 'sheets' | 'slides'
     * @returns {Promise<object>} { title, text, html, bodyHtml, charCount, meta }
     */
    static async parse(html, docType) {
        await OffscreenManager.ensure();

        const response = await chrome.runtime.sendMessage({ type: 'parse', html, docType });
        if (!response?.ok) {
            throw new Error(response?.error || 'Offscreen parse failed.');
        }

        OffscreenManager._scheduleClose();
        return response.data;
    }

    /**
     * Close the offscreen document after an idle period. Cheap to recreate,
     * and leaving it open holds the service worker alive unnecessarily.
     * @private
     */
    static _scheduleClose() {
        if (OffscreenManager._closeTimer !== null) {
            clearTimeout(OffscreenManager._closeTimer);
        }
        OffscreenManager._closeTimer = setTimeout(() => {
            OffscreenManager._closeTimer = null;
            OffscreenManager.close().catch(() => { });
        }, OffscreenManager.IDLE_CLOSE_MS);
    }

    /**
     * @returns {Promise<void>}
     */
    static async close() {
        if (await chrome.offscreen.hasDocument()) {
            await chrome.offscreen.closeDocument();
        }
    }
}

// ─── ExtensionController ────────────────────────────────────────────────────

class ExtensionController {

    /** Watchdog alarm name (spec §6.1). */
    static WATCHDOG_ALARM = 'pipelineWatchdog';

    /** A pipeline older than this is considered abandoned (SW was killed). */
    static PIPELINE_TIMEOUT_MS = 60_000;

    /**
     * Pending extraction resolver.
     * When the content script sends 'contentReady', we resolve this promise
     * so runPipeline() can continue. This is a FAST PATH only — the
     * persisted PipelineState + watchdog alarm are the actual guarantee
     * that a tab never stays script-blocked (D3).
     * @type {{ resolve: Function, reject: Function } | null}
     */
    static _pendingExtraction = null;

    /**
     * Initialize event listeners.
     */
    static init() {
        // Listen for messages from popup AND content scripts.
        //
        // chrome.runtime.sendMessage broadcasts to every extension context,
        // so this listener also sees the { type: 'parse' } messages aimed at
        // the offscreen document. Answering those would race the offscreen
        // parser's real reply and break parsing, so anything without a string
        // `action` is left alone (return undefined = "not mine").
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || typeof message.action !== 'string') return undefined;
            ExtensionController.handleMessage(message, sender, sendResponse);
            return true; // keep channel open for async
        });

        // Clean up rules/pipeline state if a tab is closed mid-extraction.
        chrome.tabs.onRemoved.addListener((tabId) => {
            ExtensionController.handleTabRemoved(tabId).catch((err) =>
                console.error('[ExtensionController] tabs.onRemoved cleanup failed:', err)
            );
        });

        // Watchdog: recover any pipeline abandoned by a killed service worker.
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === ExtensionController.WATCHDOG_ALARM) {
                ExtensionController.runWatchdog().catch((err) =>
                    console.error('[Watchdog] run failed:', err)
                );
            }
        });
        // Idempotent — re-creating an alarm with the same name just resets it.
        chrome.alarms.create(ExtensionController.WATCHDOG_ALARM, { periodInMinutes: 1 });

        // Startup / install sweep (spec §6.1): the browser itself may have
        // restarted mid-extraction, in which case even the watchdog alarm
        // never got a chance to fire. Sweep unconditionally.
        chrome.runtime.onStartup.addListener(() => {
            ExtensionController.startupSweep('onStartup').catch((err) =>
                console.error('[ExtensionController] onStartup sweep failed:', err)
            );
        });
        chrome.runtime.onInstalled.addListener(() => {
            ExtensionController.startupSweep('onInstalled').catch((err) =>
                console.error('[ExtensionController] onInstalled sweep failed:', err)
            );
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
                    try {
                        const result = await ExtensionController.runPipeline();
                        sendResponse({ success: true, data: result });
                    } catch (err) {
                        sendResponse({ success: false, error: err.message });
                    }
                    break;
                }

                case 'contentReady': {
                    // Content script auto-sent its payload (tabNav path). It
                    // ships raw HTML; parsing happens in the offscreen document
                    // so formatting resolves through a real CSS cascade (D2).
                    const data = await ExtensionController.parseContentPayload(
                        message.data,
                        _sender?.tab?.id
                    );

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
                        'lastExtractionError',
                    ]);
                    sendResponse({
                        success: true,
                        data: stored.lastExtraction || null,
                        status: stored.extractionStatus || 'idle',
                        error: stored.lastExtractionError || null,
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
     * Turn a content-script payload into the extraction result contract.
     *
     * The content script ships raw HTML and lets the offscreen parser do the
     * work, because only a real CSS cascade can resolve Google's class-based
     * formatting (D2). If that parse fails, fall back to the content script's
     * own in-page scanner: a parser regression should cost formatting quality,
     * never the document itself.
     *
     * @param {object} payload   { rawHtml, title, url, docType } or a legacy result
     * @param {number|undefined} tabId  Sending tab, used for the fallback round trip
     * @returns {Promise<object>}
     */
    static async parseContentPayload(payload, tabId) {
        if (!payload) throw new Error('Content script sent an empty payload.');

        // Legacy shape: already-parsed result, no raw HTML to reparse.
        if (!payload.rawHtml) return payload;

        try {
            const parsed = await OffscreenManager.parse(
                payload.rawHtml,
                payload.docType || 'docs'
            );
            const result = {
                ...parsed,
                meta: { ...(parsed.meta || {}), transport: 'tabNav' },
            };
            return await ExtensionController.embedImagesIntoResult(result, tabId);
        } catch (err) {
            console.error(
                '[ExtensionController] Offscreen parse failed, falling back to in-page scan:',
                err
            );

            if (tabId === undefined) throw err;

            const legacy = await chrome.tabs
                .sendMessage(tabId, { action: 'extract' })
                .catch(() => null);

            if (!legacy?.success || !legacy.data) throw err;

            return {
                ...legacy.data,
                meta: {
                    ...(legacy.data.meta || {}),
                    transport: 'tabNav',
                    warnings: [
                        ...(legacy.data.meta?.warnings || []),
                        'legacy_parser_fallback',
                    ],
                },
            };
        }
    }

    /**
     * Embed the document's own `docs.google.com` images as `data:` URIs
     * into `result.bodyHtml` (spec §4), honouring the popup's "Embed
     * images" toggle (`ImageEmbedSettings`, default ON). Called after every
     * offscreen parse that produces Docs `bodyHtml` — never for Sheets
     * (csv-derived HTML has no `<img>` tags to begin with) and never when
     * the offscreen parse itself failed (nothing to embed into).
     *
     * `ImageEmbedder.embedImages` never throws — every fetch failure
     * degrades to "keep the original src, add a warning" (spec §4.2) — so
     * the try/catch here is defense in depth only, not the real safety net.
     *
     * @param {object} result   The parse-result contract ({title, text, html, bodyHtml, charCount, meta}).
     * @param {number|undefined} tabId  The document's own tab — needed for the T2 csFetch fallback.
     * @returns {Promise<object>} A new result object; `result` is not mutated.
     */
    static async embedImagesIntoResult(result, tabId) {
        if (!result || typeof result.bodyHtml !== 'string' || result.bodyHtml.length === 0) {
            return result;
        }

        const enabled = await ImageEmbedSettings.isEnabled();
        if (!enabled) {
            console.log('[ExtensionController] Image embedding is OFF (popup toggle) — leaving image URLs as-is.');
            return result;
        }

        const oldBodyHtml = result.bodyHtml;
        let embedResult;
        try {
            embedResult = await ImageEmbedder.embedImages(oldBodyHtml, {
                tabId,
                budgetBytes: ImageEmbedder.TOTAL_BUDGET_BYTES,
            });
        } catch (err) {
            // Defense in depth only — embedImages is designed to never throw.
            console.error('[ExtensionController] embedImages threw unexpectedly (non-fatal, keeping original bodyHtml):', err);
            return result;
        }

        const { bodyHtml: newBodyHtml, stats } = embedResult;

        // The clipboard's text/html flavour is `result.html`, not
        // `result.bodyHtml` (spec §5) — it must carry the same embedded
        // images, so rebuild it around the new bodyHtml too.
        const newHtml = ExtensionController._spliceBodyHtml(result.html, oldBodyHtml, newBodyHtml);

        return {
            ...result,
            bodyHtml: newBodyHtml,
            html: newHtml,
            meta: {
                ...(result.meta || {}),
                warnings: [...(result.meta?.warnings || []), ...stats.warnings],
                imageStats: stats,
            },
        };
    }

    /**
     * Replace the (single, verbatim) `oldBodyHtml` substring inside
     * `fullHtml` with `newBodyHtml`. `fullHtml` is produced by the
     * offscreen parser's `wrapAsDocument(bodyHtml, title)` — a fixed head/
     * body shell around exactly one copy of `bodyHtml` — so locating that
     * substring and splicing is equivalent to (and far cheaper than)
     * re-running the wrap template, which isn't reachable from here anyway
     * (it's a private static method of `OffscreenParser`, spec §6 keeps
     * `offscreen/parser.js` out of this file's scope).
     *
     * Deliberately uses indexOf + slice, not `String.replace` — `replace`'s
     * string form treats `$&`/`$1`/`$$`/... specially in the REPLACEMENT
     * text, and `newBodyHtml` is untrusted document content that could
     * legitimately contain a literal `$1` (e.g. a price).
     *
     * @param {string} fullHtml
     * @param {string} oldBodyHtml
     * @param {string} newBodyHtml
     * @returns {string}
     * @private
     */
    static _spliceBodyHtml(fullHtml, oldBodyHtml, newBodyHtml) {
        if (typeof fullHtml !== 'string' || !oldBodyHtml) return fullHtml;
        const idx = fullHtml.indexOf(oldBodyHtml);
        if (idx === -1) {
            console.warn(
                '[ExtensionController] Could not locate bodyHtml inside the full wrapped document — ' +
                'html left without embedded images (bodyHtml/clipboard text still has them).'
            );
            return fullHtml;
        }
        return fullHtml.slice(0, idx) + newBodyHtml + fullHtml.slice(idx + oldBodyHtml.length);
    }

    /**
     * Full extraction pipeline. Dispatches to the fetch (Docs), swFetch
     * (Sheets), or tabNav (Docs fallback) transport via `dispatchTransport`,
     * based on `UrlTransformer.toExtractionTarget()`.
     * @returns {Promise<{ title: string, text: string, charCount: number }>}
     */
    static async runPipeline() {
        // Concurrency guard (spec §6.3): a second startExtraction while one
        // is genuinely in flight must not corrupt the persisted pipeline
        // slot. A pipeline older than the watchdog timeout is NOT treated
        // as "in progress" — it's stale, and the watchdog (or this very
        // call, indirectly, by overwriting it) will clean it up.
        const existing = await PipelineState.get();
        if (existing && (Date.now() - existing.startedAt) < ExtensionController.PIPELINE_TIMEOUT_MS) {
            throw new Error('extraction_in_progress');
        }

        // Mark extraction as in-progress
        await chrome.storage.session.set({
            extractionStatus: 'running',
            lastExtraction: null,
            lastExtractionError: null,
        });

        // 1. Get active tab
        const tab = await ExtensionController.getActiveTab();
        const { isValid, type } = UrlTransformer.identify(tab.url);

        if (!isValid) {
            await chrome.storage.session.set({ extractionStatus: 'error' });
            throw new Error('Active tab is not a Google Docs/Sheets/Slides page.');
        }

        const docId = UrlTransformer.getDocId(tab.url);
        const target = UrlTransformer.toExtractionTarget(tab.url);

        if (!target) {
            await chrome.storage.session.set({ extractionStatus: 'error' });
            throw new Error(
                type === 'slides'
                    ? 'Google Slides is not supported yet.'
                    : 'Failed to build an extraction target for this URL.'
            );
        }

        try {
            const result = await ExtensionController.dispatchTransport(tab, target, docId);
            return result;
        } catch (err) {
            await chrome.storage.session.set({
                extractionStatus: 'error',
                lastExtractionError: err.message,
            });
            // Belt-and-suspenders: whichever sub-pipeline threw is
            // responsible for its own cleanup in its `finally`, but make
            // sure nothing lingers regardless of where it threw from.
            await PipelineState.clear();
            throw err;
        }
    }

    /**
     * Route to the transport implied by `target.mode`.
     *
     *   'fetch'   → docs, via `runFetchHtmlPipeline` (T1/T2). Falls back to
     *               the legacy `runTabNavPipeline` (T3) if every fetch tier
     *               fails — never leaves a restricted Doc unextractable
     *               just because Google's cookie bootstrap breaks under
     *               DNR script-blocking (see the file header bug note).
     *   'swFetch' → sheets, via `runSwFetchPipeline`. Unchanged.
     *   anything else → legacy `tabNav`, kept for forward-compat with any
     *               strategy that explicitly asks for it.
     *
     * @param {chrome.tabs.Tab} tab
     * @param {{url: string, parser: string, mode: string}} target
     * @param {string} docId
     * @returns {Promise<object>}
     */
    static async dispatchTransport(tab, target, docId) {
        if (target.mode === 'swFetch') {
            return ExtensionController.runSwFetchPipeline(tab, target, docId);
        }

        if (target.mode === 'fetch') {
            try {
                return await ExtensionController.runFetchHtmlPipeline(tab, target, docId);
            } catch (err) {
                console.warn(
                    '[ExtensionController] Fetch transport failed on every tier ' +
                    `(${err.message}) — falling back to tabNav.`
                );

                const result = await ExtensionController.runTabNavPipeline(tab, target, docId);
                result.meta = {
                    ...(result.meta || {}),
                    warnings: [...(result.meta?.warnings || []), 'tabnav_fallback'],
                };

                // The fallback's own `finally` already stored `result` via
                // chrome.storage.session — overwrite with the warning-
                // annotated version so a popup that recovers via
                // getExtractionStatus also sees it.
                await chrome.storage.session.set({
                    lastExtraction: result,
                    extractionStatus: 'complete',
                });

                return result;
            }
        }

        return ExtensionController.runTabNavPipeline(tab, target, docId);
    }

    /**
     * Docs extraction — fetch transport (spec §3.2, T1 `swFetch` then T2
     * `csFetch`, pulled forward from P3 to fix the tabNav regression: see
     * the file header). No DNR rule, no `chrome.tabs.update` — the user's
     * tab is never touched. If both fetch tiers fail, this throws and the
     * caller (`dispatchTransport`) falls back to `runTabNavPipeline`.
     *
     * @param {chrome.tabs.Tab} tab
     * @param {{url: string, parser: string, mode: string}} target
     * @param {string} docId
     * @returns {Promise<object>}
     */
    static async runFetchHtmlPipeline(tab, target, docId) {
        const tabId = tab.id;
        await PipelineState.write({
            phase: 'fetching',
            tabId,
            ruleId: null,
            startedAt: Date.now(),
            docId,
        });

        try {
            const { html, transport } = await fetchDocHtml({ url: target.url, tabId });

            await PipelineState.write({ phase: 'parsing' });

            const parsed = await OffscreenManager.parse(html, 'docs');

            let result = {
                ...parsed,
                meta: {
                    ...(parsed.meta || {}),
                    transport,
                    docType: 'docs',
                    docId,
                },
            };

            await PipelineState.write({ phase: 'embedding-images' });
            result = await ExtensionController.embedImagesIntoResult(result, tabId);

            await chrome.storage.session.set({
                lastExtraction: result,
                extractionStatus: 'complete',
            });

            return result;
        } finally {
            // No DNR rule and no tab was ever touched — clearing the
            // pipeline slot is the only cleanup needed (mirrors
            // runSwFetchPipeline).
            await PipelineState.clear();
        }
    }

    /**
     * Sheets extraction — fetches the `gviz` CSV export directly from the
     * service worker. No tab navigation, no DNR rule (fixes D1 for Sheets;
     * see spec §3.2 T1 `swFetch`).
     *
     * P1 always reads `gid=0` — only the first sheet. This is surfaced via
     * `meta.warnings: ['single_sheet_only']` and must never be silent.
     *
     * @param {chrome.tabs.Tab} tab
     * @param {{url: string, parser: string, mode: string}} target
     * @param {string} docId
     * @returns {Promise<object>}
     */
    static async runSwFetchPipeline(tab, target, docId) {
        const tabId = tab.id;
        await PipelineState.write({
            phase: 'fetching',
            tabId,
            ruleId: null,
            startedAt: Date.now(),
            docId,
        });

        try {
            let response;
            try {
                response = await fetch(target.url, { credentials: 'include' });
            } catch (err) {
                throw new Error(`Network request failed while fetching the sheet: ${err.message}`);
            }

            // Login-wall via redirect (e.g. accounts.google.com/ServiceLogin).
            if (response.url && /accounts\.google\.com|\/ServiceLogin/i.test(response.url)) {
                throw new Error(
                    'This spreadsheet requires sign-in — the extension could not access it ' +
                    '(redirected to a Google login page).'
                );
            }

            const contentType = response.headers.get('content-type') || '';
            const bodyText = await response.text();

            if (!response.ok) {
                throw new Error(`Failed to fetch sheet data (HTTP ${response.status}).`);
            }

            // Login-wall / access-wall via body content (gviz returns a
            // small HTML/JS error payload, not a CSV, when access is denied).
            //
            // Gate this on the content type: a legitimate spreadsheet can
            // legitimately contain the words "Sign in" (an attendance or
            // sign-in sheet), and matching the wall pattern against CSV cell
            // data would reject that user's own document. Only a non-CSV
            // response can be an access wall.
            const isCsvResponse = /text\/csv|application\/csv/i.test(contentType);
            if (!isCsvResponse && /Sign in|You need access|Request access/i.test(bodyText)) {
                throw new Error(
                    'This spreadsheet requires access — the extension could not read it ' +
                    '(access wall detected in the response).'
                );
            }

            // The gviz endpoint answers errors with an HTML/JS payload rather
            // than a non-2xx status. Feeding that to the CSV parser would
            // produce convincing-looking garbage, so refuse it outright.
            if (!isCsvResponse && /^\s*(<!DOCTYPE|<html|\)\]\}')/i.test(bodyText)) {
                throw new Error(
                    'The spreadsheet endpoint returned a non-CSV response — the sheet may be ' +
                    'restricted, empty, or the gviz endpoint has changed.'
                );
            }

            await PipelineState.write({ phase: 'parsing' });

            const rows = parseCsv(bodyText);
            const { bodyHtml, text, charCount } = csvToHtml(rows);
            const title = (tab.title || '').replace(/ - Google Sheets.*/i, '').trim() || 'Untitled Spreadsheet';
            const html = HtmlDocument.wrap(bodyHtml, title);

            const result = {
                title,
                text,
                html,
                bodyHtml,
                charCount,
                meta: {
                    transport: 'swFetch',
                    docType: 'sheets',
                    docId,
                    // P1 only ever reads gid=0 — never let this be silent.
                    warnings: ['single_sheet_only'],
                },
            };

            await chrome.storage.session.set({
                lastExtraction: result,
                extractionStatus: 'complete',
            });

            return result;
        } finally {
            // No DNR rule and no tab was ever touched — clearing the
            // pipeline slot is the only cleanup needed.
            await PipelineState.clear();
        }
    }

    /**
     * Docs extraction — legacy v1 behaviour (DNR-block JS on the tab,
     * navigate to /mobilebasic, content script scrapes, restore JS).
     *
     * LAST-RESORT FALLBACK ONLY as of the T1/T2 fetch-transport fix: this
     * is the pipeline that redirects to
     * support.google.com/accounts/answer/32050 in the real browser (see the
     * file header), because blocking scripts breaks Google's own cookie
     * bootstrap. `dispatchTransport` only reaches this when
     * `runFetchHtmlPipeline` (T1 `swFetch` / T2 `csFetch`) has already
     * failed on every tier. Kept intact, not deleted — persisted pipeline
     * state + allocator rule ids (fixes D3/D4) unchanged.
     *
     * @param {chrome.tabs.Tab} tab
     * @param {{url: string, parser: string, mode: string}} target
     * @param {string} docId
     * @returns {Promise<object>}
     */
    static async runTabNavPipeline(tab, target, docId) {
        const tabId = tab.id;
        const ruleId = await PolicyManager.allocateRuleId(tabId);

        // Written BEFORE the DNR rule is added — if the SW dies right
        // after this line, the watchdog/startup sweep still knows a rule
        // may exist for this tab and will remove it.
        await PipelineState.write({
            phase: 'blocking',
            tabId,
            ruleId,
            startedAt: Date.now(),
            docId,
        });

        await PolicyManager.blockJavaScript(tabId, ruleId);

        try {
            await PipelineState.write({ phase: 'navigating' });

            // Create a promise that the content script will resolve when
            // it sends 'contentReady' after auto-injection.
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

            // Navigate the tab to mobilebasic.
            // (This will likely close the popup — that's OK, results go to session storage)
            await chrome.tabs.update(tabId, { url: target.url });

            // Wait for the page to finish loading
            await ExtensionController.waitForTabLoad(tabId);

            await PipelineState.write({ phase: 'extracting' });

            // Wait for content script to send extracted data. The content
            // script is auto-injected by manifest content_scripts and runs
            // its own readiness detector (spec §4.4) before scanning.
            const extractedData = await contentPromise;

            extractedData.meta = {
                ...(extractedData.meta || {}),
                transport: 'tabNav',
                docType: 'docs',
                docId,
            };

            // Store the final result (already done in contentReady handler, but ensure)
            await chrome.storage.session.set({
                lastExtraction: extractedData,
                extractionStatus: 'complete',
            });

            return extractedData;

        } finally {
            // Always restore JavaScript and release the rule id — this
            // `finally` is now a FAST PATH, not the only guarantee (D3).
            // The watchdog alarm and the startup sweep back it up.
            await PolicyManager.restoreJavaScript(ruleId);
            await PolicyManager.releaseRuleId(ruleId);
            await PipelineState.clear();
        }
    }

    /**
     * Watchdog: fires every minute via chrome.alarms. Any persisted
     * pipeline older than PIPELINE_TIMEOUT_MS is treated as abandoned —
     * almost certainly because the service worker that owned it was
     * terminated mid-flight — and is force-recovered (fixes D3).
     * @returns {Promise<void>}
     */
    static async runWatchdog() {
        const pipeline = await PipelineState.get();
        if (!pipeline) return;

        const age = Date.now() - pipeline.startedAt;
        if (age <= ExtensionController.PIPELINE_TIMEOUT_MS) return;

        console.warn(
            `[Watchdog] Stale pipeline detected (age ${age}ms, tab ${pipeline.tabId}) — recovering.`
        );

        if (pipeline.ruleId !== null && pipeline.ruleId !== undefined) {
            await PolicyManager.restoreJavaScript(pipeline.ruleId).catch((err) =>
                console.error('[Watchdog] restoreJavaScript failed:', err)
            );
            await PolicyManager.releaseRuleId(pipeline.ruleId).catch((err) =>
                console.error('[Watchdog] releaseRuleId failed:', err)
            );
        }

        await chrome.storage.session.set({
            extractionStatus: 'error',
            lastExtractionError:
                'Extraction timed out and was recovered automatically. ' +
                'Any blocked scripts on the tab have been restored.',
        });
        await PipelineState.clear();
    }

    /**
     * Startup / install sweep (spec §6.1): remove every session DNR rule
     * in the 9000-9999 band and clear allocator/pipeline state. Handles
     * the case where the BROWSER (not just the service worker) restarted
     * mid-extraction, which the watchdog alarm alone cannot catch.
     * @param {string} reason  'onStartup' | 'onInstalled' — for logging.
     * @returns {Promise<void>}
     */
    static async startupSweep(reason) {
        await PolicyManager.sweepAllRules();
        await chrome.storage.session.remove(['ruleAlloc', 'pipeline']);
        console.log(`[ExtensionController] Startup sweep complete (${reason}).`);
    }

    /**
     * Clean up rule/pipeline state for a tab that was closed mid-extraction.
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    static async handleTabRemoved(tabId) {
        const ruleId = await PolicyManager.ruleIdForTab(tabId);
        if (ruleId !== null) {
            await PolicyManager.restoreJavaScript(ruleId);
            await PolicyManager.releaseRuleId(ruleId);
        }

        const pipeline = await PipelineState.get();
        if (pipeline && pipeline.tabId === tabId) {
            await PipelineState.clear();
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
