/**
 * pipeline-runner.js — dispatch, the concurrency guard, the watchdog, the
 * startup sweep, and tab-removal cleanup (spec v3 P2). Moved from
 * background/service-worker.js's `ExtensionController`.
 *
 * Three transports exist for extraction:
 *
 *   docs   (fetch)    1. Validate URL → 2. http-transport.js's
 *                     fetchDocHtml() (T1 swFetch, then T2 csFetch) →
 *                     3. Offscreen parse → 4. Store result — no tab
 *                     touched, no DNR rule.
 *   sheets (swFetch)  1. Validate URL → 2. fetch({credentials:'include'}) →
 *                     3. Parse CSV → 4. Build HTML — no tab touched, no DNR
 *                     rule.
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
 * fails outright — see `dispatchTransport` below and
 * http-transport.js's file header for the full measurement.
 *
 * The watchdog, the rule allocator (platform/net-rules.js) and the
 * startup sweep are the machinery that stops a tab being left
 * script-blocked if the service worker is killed mid-extraction (spec v3
 * §10 risk) — this file's `runWatchdog`/`startupSweep`/`handleTabRemoved`
 * are unchanged from the original service worker, only their imports
 * moved.
 */
import { TIMING, WARNINGS, DOC_TYPES, TRANSPORTS, SESSION_KEYS, EXTRACTION_STATUS } from '../shared/constants.js';
import { UrlTransformer } from '../core/document-url.js';
import { AppError } from '../core/app-error.js';
import { toExtractionTarget } from './targets.js';
import { PolicyManager } from '../platform/net-rules.js';
import { getActiveTab } from '../platform/tabs.js';
import {
    setExtractionRunning,
    setExtractionStatus,
    setExtractionError,
    setExtractionComplete,
    sessionRemove,
} from '../platform/storage.js';
import { PipelineState } from './pipeline-state.js';
import { runFetchHtmlPipeline } from './fetch-pipeline.js';
import { runSwFetchPipeline } from './csv-pipeline.js';
import { runTabNavPipeline } from './tabnav-pipeline.js';

/** A pipeline older than this is considered abandoned (SW was killed). */
const PIPELINE_TIMEOUT_MS = TIMING.PIPELINE_TIMEOUT_MS;

/**
 * Shape an error for `platform/storage.js`'s `setExtractionError` (spec v3
 * §5.3): an AppError's `code`/`params` survive the round trip through
 * storage so a popup that recovers via `getExtractionStatus` can still
 * translate it; a plain Error degrades to its raw `message` only.
 * @param {Error} err
 * @returns {{code?: string, params?: object, message: string}}
 */
function toStoredError(err) {
    return err instanceof AppError
        ? { code: err.code, params: err.params, message: err.message }
        : { message: err.message };
}

/**
 * Full extraction pipeline. Dispatches to the fetch (Docs), swFetch
 * (Sheets), or tabNav (Docs fallback) transport via `dispatchTransport`,
 * based on `targets.js`'s `toExtractionTarget()`.
 * @returns {Promise<{ title: string, text: string, charCount: number }>}
 */
export async function runPipeline() {
    // Concurrency guard (spec §6.3): a second startExtraction while one
    // is genuinely in flight must not corrupt the persisted pipeline
    // slot. A pipeline older than the watchdog timeout is NOT treated
    // as "in progress" — it's stale, and the watchdog (or this very
    // call, indirectly, by overwriting it) will clean it up.
    const existing = await PipelineState.get();
    if (existing && (Date.now() - existing.startedAt) < PIPELINE_TIMEOUT_MS) {
        throw new AppError('error.extractionInProgress');
    }

    // Mark extraction as in-progress
    await setExtractionRunning();

    // 1. Get active tab
    const tab = await getActiveTab();
    const { isValid, type } = UrlTransformer.identify(tab.url);

    if (!isValid) {
        await setExtractionStatus(EXTRACTION_STATUS.ERROR);
        throw new AppError('error.notADocPage');
    }

    const docId = UrlTransformer.getDocId(tab.url);
    const target = toExtractionTarget(tab.url);

    if (!target) {
        await setExtractionStatus(EXTRACTION_STATUS.ERROR);
        throw new AppError(type === DOC_TYPES.SLIDES ? 'error.slidesUnsupported' : 'error.noExtractionTarget');
    }

    try {
        const result = await dispatchTransport(tab, target, docId);
        return result;
    } catch (err) {
        await setExtractionError(toStoredError(err));
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
 * @param {object} tab   The active tab (chrome tabs.Tab shape).
 * @param {{url: string, parser: string, mode: string}} target
 * @param {string} docId
 * @returns {Promise<object>}
 */
export async function dispatchTransport(tab, target, docId) {
    if (target.mode === TRANSPORTS.SW_FETCH) {
        return runSwFetchPipeline(tab, target, docId);
    }

    if (target.mode === 'fetch') {
        try {
            return await runFetchHtmlPipeline(tab, target, docId);
        } catch (err) {
            console.warn(
                '[pipeline-runner] Fetch transport failed on every tier ' +
                `(${err.message}) — falling back to tabNav.`
            );

            const result = await runTabNavPipeline(tab, target, docId);
            result.meta = {
                ...(result.meta || {}),
                warnings: [...(result.meta?.warnings || []), WARNINGS.TABNAV_FALLBACK],
            };

            // The fallback's own `finally` already stored `result` via
            // storage.js — overwrite with the warning-annotated version
            // so a popup that recovers via getExtractionStatus also sees
            // it.
            await setExtractionComplete(result);

            return result;
        }
    }

    return runTabNavPipeline(tab, target, docId);
}

/**
 * Watchdog: fires every minute via the alarm registered in
 * platform/alarms.js. Any persisted pipeline older than PIPELINE_TIMEOUT_MS
 * is treated as
 * abandoned — almost certainly because the service worker that owned it
 * was terminated mid-flight — and is force-recovered (fixes D3).
 * @returns {Promise<void>}
 */
export async function runWatchdog() {
    const pipeline = await PipelineState.get();
    if (!pipeline) return;

    const age = Date.now() - pipeline.startedAt;
    if (age <= PIPELINE_TIMEOUT_MS) return;

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

    await setExtractionError(toStoredError(new AppError('error.watchdogRecovered')));
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
export async function startupSweep(reason) {
    await PolicyManager.sweepAllRules();
    await sessionRemove([SESSION_KEYS.RULE_ALLOC, SESSION_KEYS.PIPELINE]);
    console.log(`[pipeline-runner] Startup sweep complete (${reason}).`);
}

/**
 * Clean up rule/pipeline state for a tab that was closed mid-extraction.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function handleTabRemoved(tabId) {
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
