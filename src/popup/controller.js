/**
 * popup-controller.js — flow and messaging for the popup.
 *
 * Owns: init (including popup-recovery after being closed mid-extraction),
 * the tab check, starting an extraction, status polling, the embed-images
 * toggle's persistence, and the four export button handlers. Every
 * `chrome.*` call and every decision about what happens next lives here;
 * every DOM write is delegated to popup-view.js.
 *
 * Split out of entry/popup.js (spec v3 §4 P2) — same messages to the
 * service worker, same recovery behaviour, same popup flow.
 */

import { EXTRACTION_STATUS, TRANSPORTS, DOC_TYPES } from '../lib/const.js';
import { I18n } from '../lib/i18n/index.js';
import {
    getStoredLanguage, setStoredLanguage, detectLanguage,
    getEmbedImages, setEmbedImages,
} from '../bridge/prefs.js';
import * as background from '../bridge/to-background.js';
import * as view from './view.js';
import * as exportsApi from './export.js';

// ── State ────────────────────────────────────────────────────────

let extractedData = null;
let currentDocTitle = 'document';
let currentDocType = null;
let pollTimer = null;

/**
 * The last dynamic view rendered, so a language switch (spec v3 §5.5) can
 * re-render exactly that state in the new language — without restarting
 * polling, resetting button state, or touching `extractedData` — instead of
 * guessing. `{kind: 'idle'}` means "nothing dynamic shown yet; the static
 * [data-i18n] labels are enough."
 */
let currentView = { kind: 'idle' };

/** @param {string} kind @param {object} [payload] */
function setView(kind, payload = {}) {
    currentView = { kind, payload };
}

function stepModeForTransport(transport) {
    return transport === TRANSPORTS.TAB_NAV ? 'tabnav' : 'fetch';
}

/**
 * Turn an error-ish value into display text, preferring a translated
 * message over a raw one: an AppError-shaped value (`{code, params}`, from
 * background.js's structured response or a stored `{code, params, message}`
 * — spec v3 §5.3) translates via `code`; anything else falls back to its
 * own raw message, and only the caller-supplied fallback key is used if
 * there is truly nothing to show. Degrade, never blank.
 * @param {{code?: string, params?: object, message?: string}|Error|string|null|undefined} err
 * @param {string} fallbackKey
 * @returns {string}
 */
function errorText(err, fallbackKey) {
    if (!err) return I18n.t(fallbackKey);
    if (typeof err === 'string') return err;
    if (typeof err.code === 'string') return I18n.t(err.code, err.params);
    return err.message || I18n.t(fallbackKey);
}

/** Store the result and render it — shared by init recovery, polling recovery, and a live extraction. */
function presentResult(data) {
    extractedData = data;
    view.setStepMode(stepModeForTransport(data.meta?.transport));
    setView('result');
    view.renderExtractionResult(data);
}

// ── Language (spec v3 §5.2/§5.5) ───────────────────────────────────

/** Load the persisted/detected language and apply it before the first render. */
export async function initI18n() {
    await I18n.init({ getStoredLanguage, detectLanguage, setStoredLanguage });
    view.setSelectedLanguage(I18n.getLanguage());
    view.applyStaticI18n();
}

/**
 * Switch language and re-render immediately — no reopen (spec v3 §5.5).
 * Re-renders only the currently-visible dynamic state (via `currentView`)
 * with the same data, so an in-flight extraction's polling/timers and a
 * displayed result's `extractedData` are both left completely untouched.
 */
export async function handleLanguageChange() {
    await I18n.setLanguage(view.getSelectedLanguage());
    view.applyStaticI18n();
    rerenderCurrentView();
}

function rerenderCurrentView() {
    const { kind, payload } = currentView;
    switch (kind) {
        case 'docDetected': view.renderDocDetected(payload.type, payload.url); break;
        case 'notADoc': view.renderNotADoc(); break;
        case 'slidesUnsupported': view.renderSlidesUnsupported(); break;
        case 'initError': view.renderInitError(payload.message); break;
        case 'recoveryRunning': view.renderRecoveryRunning(); break;
        case 'result': view.renderExtractionResult(extractedData); break;
        case 'failed': view.renderExtractionFailed(payload.message); break;
        case 'extracting':
            view.setStatus('🔄', I18n.t('popup.status.extracting'), I18n.t(payload.detailKey));
            break;
        default: break; // 'idle' — nothing dynamic to redraw
    }
}

// ── Embed-images toggle (spec §4.4) ────────────────────────────────
// Default ON — whether Google Docs accepts data: URI images on paste is
// unverified (spec §8), so this checkbox is the escape hatch, not the
// expected common case.

export async function initEmbedImagesToggle() {
    view.setEmbedImagesChecked(await getEmbedImages());
}

export async function handleEmbedImagesChange() {
    try {
        await setEmbedImages(view.getEmbedImagesChecked());
    } catch (err) {
        console.error('[Popup] Failed to persist embed-images setting:', err);
    }
}

// ── Init ─────────────────────────────────────────────────────────

export async function init() {
    try {
        // Check for completed or running extraction (popup recovery)
        const statusResp = await background.getExtractionStatus();

        if (statusResp?.status === EXTRACTION_STATUS.COMPLETE && statusResp.data) {
            presentResult(statusResp.data);
            return;
        }

        if (statusResp?.status === EXTRACTION_STATUS.RUNNING) {
            // The fetch transport (T1/T2) never navigates the tab, so it
            // can't be the reason the popup needed recovering — a popup
            // that had to poll back in almost certainly means the tabNav
            // fallback fired and navigated the tab out from under it.
            setView('recoveryRunning');
            view.renderRecoveryRunning();
            startPolling();
            return;
        }

        // Normal init — check if current tab is a Google Doc
        const response = await background.checkTab();

        if (response?.success && response.data.isValid) {
            currentDocTitle = response.data.title || 'document';
            currentDocType = response.data.type;

            if (response.data.type === DOC_TYPES.SLIDES) {
                // D1: Slides has no working extraction path in P1 — don't
                // let the user start a pipeline that can only fail.
                setView('slidesUnsupported');
                view.renderSlidesUnsupported();
            } else {
                setView('docDetected', { type: response.data.type, url: response.data.url });
                view.renderDocDetected(response.data.type, response.data.url);
            }
        } else {
            setView('notADoc');
            view.renderNotADoc();
        }
    } catch (err) {
        setView('initError', { message: err.message });
        view.renderInitError(err.message);
    }
}

// ── Polling ──────────────────────────────────────────────────────

export function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        try {
            const resp = await background.getExtractionStatus();
            if (resp?.status === EXTRACTION_STATUS.COMPLETE && resp.data) {
                stopPolling();
                presentResult(resp.data);
            } else if (resp?.status === EXTRACTION_STATUS.ERROR) {
                stopPolling();
                const message = errorText(resp.error, 'error.checkStatusFallback');
                setView('failed', { message });
                view.renderExtractionFailed(message);
                view.setExtractButtonDisabled(currentDocType === DOC_TYPES.SLIDES);
            }
        } catch { /* keep polling */ }
    }, 1000);
}

export function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Extract ──────────────────────────────────────────────────────

export async function handleExtract() {
    if (currentDocType === DOC_TYPES.SLIDES) {
        // Defensive — the button should already be disabled (see init()),
        // but never let this fall through to a pipeline that can't work.
        view.showNotification(I18n.t('error.slidesUnsupported'), 'error');
        return;
    }

    view.beginExtractionUI();

    // Docs and Sheets both default to a transport that never touches the
    // tab now (Docs: swFetch/csFetch, spec §3.2; Sheets: swFetch,
    // unchanged) — the tab is never navigated, and the popup gets its
    // result straight from this one response instead of via a
    // navigation-triggered close/reopen. tabNav only runs as an explicit
    // last-resort fallback if every fetch tier fails; if it does, we
    // switch the display below once we know.
    view.setStepMode('fetch');

    try {
        view.setStep(0);
        setView('extracting', { detailKey: 'popup.status.validating' });
        view.setStatus('🔄', I18n.t('popup.status.extracting'), I18n.t('popup.status.validating'));
        await delay(300);

        view.setStep(1);
        const fetchingKey = currentDocType === DOC_TYPES.SHEETS ? 'popup.status.fetchingSheet' : 'popup.status.fetchingDoc';
        setView('extracting', { detailKey: fetchingKey });
        view.setStatus('🔄', I18n.t('popup.status.extracting'), I18n.t(fetchingKey));
        await delay(300);

        view.setStep(2);
        setView('extracting', { detailKey: 'popup.status.parsing' });
        view.setStatus('🔄', I18n.t('popup.status.extracting'), I18n.t('popup.status.parsing'));

        startPolling();

        const response = await background.startExtraction();

        stopPolling();

        if (!response?.success) {
            throw new Error(errorText({ code: response?.code, params: response?.params, message: response?.error }, 'error.extractionFailed'));
        }

        // Every fetch tier may have failed, in which case the background
        // pipeline fell back to the legacy block-JS + navigate path
        // (meta.warnings carries 'tabnav_fallback', surfaced via the
        // warnings banner). The extraction has already finished by the
        // time we learn this — presentResult() picks the matching step
        // layout from response.data.meta.transport before rendering.
        presentResult(response.data);

    } catch (err) {
        stopPolling();
        console.error('[Popup]', err);
        setView('failed', { message: err.message });
        view.renderExtractionFailed(err.message);
        view.showNotification(err.message, 'error');
        view.setExtractButtonDisabled(false);
    }
}

// ── Copy with formatting ─────────────────────────────────────────

export async function handleCopy() {
    if (!extractedData) return;

    const mode = await exportsApi.copyRichContent(extractedData.html, extractedData.text);
    if (mode === 'rich') {
        view.showNotification(I18n.t('popup.notify.copyRich'), 'success');
    } else if (mode === 'plain') {
        view.showNotification(I18n.t('popup.notify.copyPlain'), 'info');
    } else {
        view.showNotification(I18n.t('popup.notify.copyFallback'), 'info');
    }
}

// ── Open in New Google Doc ────────────────────────────────────────

export async function handleNewDoc() {
    if (!extractedData) return;

    // First, copy with formatting to clipboard
    await handleCopy();

    // Then open a new Google Doc
    try {
        await background.openNewDoc();
        view.showNotification(I18n.t('popup.notify.newDocOpened'), 'info');
    } catch (err) {
        view.showNotification(I18n.t('popup.notify.newDocFailed', { message: err.message }), 'error');
    }
}

// ── Download .docx (Office 2007+) ──────────────────────────────────

export async function handleDownloadDocx() {
    if (!extractedData) return;

    const filename = exportsApi.sanitizeFilename(extractedData.title || currentDocTitle) + '.docx';

    try {
        await exportsApi.downloadDocx(extractedData.bodyHtml, extractedData.title || currentDocTitle, filename);
        view.showNotification(I18n.t('popup.notify.docxDownloading', { filename }), 'success');
    } catch (err) {
        console.error('[Popup] DOCX generation error:', err);
        view.showNotification(I18n.t('popup.notify.docxFailed', { message: err.message }), 'error');
    }
}

// ── Download .txt ────────────────────────────────────────────────

export async function handleDownloadTxt() {
    if (!extractedData?.text) return;

    const filename = exportsApi.sanitizeFilename(extractedData.title || currentDocTitle) + '.txt';

    try {
        await exportsApi.downloadTxt(extractedData.text, filename, 'text/plain');
        view.showNotification(I18n.t('popup.notify.txtDownloading', { filename }), 'success');
    } catch (err) {
        view.showNotification(I18n.t('popup.notify.txtFailed', { message: err.message }), 'error');
    }
}

// ── Utils ────────────────────────────────────────────────────────

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
