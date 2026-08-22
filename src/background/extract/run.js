/**
 * Dispatch, concurrency guard, watchdog, startup sweep, tab-removal cleanup.
 *
 * Three backends: via-fetch (Docs), via-csv (Sheets), via-tabnav (last
 * resort). tabnav is last because blocking scripts breaks Google's cookie
 * bootstrap, redirecting /mobilebasic to the "clear cache and cookies" page;
 * a plain fetch reaches it directly.
 *
 * The watchdog, the rule allocator and the startup sweep are what stop a tab
 * being left script-blocked when the service worker is killed mid-extraction.
 */
import { TIMING, WARNINGS, DOC_TYPES, TRANSPORTS, SESSION_KEYS, EXTRACTION_STATUS } from '../../lib/const.js';
import { UrlTransformer } from '../../lib/url.js';
import { AppError } from '../../lib/error.js';
import { toExtractionTarget } from './route.js';
import { PolicyManager } from '../../bridge/chrome/netrules.js';
import { getActiveTab } from '../../bridge/chrome/tabs.js';
import {
    setExtractionRunning,
    setExtractionStatus,
    setExtractionError,
    setExtractionComplete,
    sessionRemove,
} from '../../bridge/chrome/storage.js';
import { PipelineState } from './state.js';
import { runFetchHtmlPipeline } from './via-fetch.js';
import { runSwFetchPipeline } from './via-csv.js';
import { runTabNavPipeline } from './via-tabnav.js';

/** A pipeline older than this is considered abandoned (SW was killed). */
const PIPELINE_TIMEOUT_MS = TIMING.PIPELINE_TIMEOUT_MS;

/**
 * An AppError's `code`/`params` survive storage so a recovering popup can
 * still translate it; a plain Error degrades to its raw `message`.
 * @param {Error} err
 * @returns {{code?: string, params?: object, message: string}}
 */
function toStoredError(err) {
    return err instanceof AppError
        ? { code: err.code, params: err.params, message: err.message }
        : { message: err.message };
}

/**
 * Full extraction pipeline, routed by `route.js`'s `toExtractionTarget()`.
 * @returns {Promise<{ title: string, text: string, charCount: number }>}
 */
export async function runPipeline() {
    // A second start must not corrupt the persisted slot. Older than the
    // watchdog timeout is stale, not in progress.
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
        // Each backend cleans up in its own `finally`; this catches a throw
        // from anywhere else.
        await PipelineState.clear();
        throw err;
    }
}

/**
 * 'fetch' → via-fetch, falling back to via-tabnav when every tier fails.
 * 'swFetch' → via-csv. Anything else → via-tabnav.
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
                '[extract/run] Fetch transport failed on every tier ' +
                `(${err.message}) — falling back to tabNav.`
            );

            const result = await runTabNavPipeline(tab, target, docId);
            result.meta = {
                ...(result.meta || {}),
                warnings: [...(result.meta?.warnings || []), WARNINGS.TABNAV_FALLBACK],
            };

            // The fallback already stored `result`; overwrite it with the
            // warning-annotated version so a recovering popup sees it.
            await setExtractionComplete(result);

            return result;
        }
    }

    return runTabNavPipeline(tab, target, docId);
}

/**
 * Fires every minute. A pipeline past PIPELINE_TIMEOUT_MS was abandoned by a
 * terminated service worker, and is force-recovered.
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
 * Drop every session DNR rule in the 9000-9999 band and clear allocator and
 * pipeline state. Catches a BROWSER restart, which the alarm cannot.
 * @param {string} reason  'onStartup' | 'onInstalled' — for logging.
 * @returns {Promise<void>}
 */
export async function startupSweep(reason) {
    await PolicyManager.sweepAllRules();
    await sessionRemove([SESSION_KEYS.RULE_ALLOC, SESSION_KEYS.PIPELINE]);
    console.log(`[extract/run] Startup sweep complete (${reason}).`);
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
