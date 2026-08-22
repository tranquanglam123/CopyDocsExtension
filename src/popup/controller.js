/**
 * Popup flow: init and recovery, the tab check, extraction, polling, the
 * embed toggle, the export handlers. Every decision lives here; every DOM
 * write goes through view.js and every message through bridge/.
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
 * The last dynamic view, so a language switch re-renders exactly that state
 * without restarting polling or touching `extractedData`. 'idle' means the
 * static [data-i18n] labels are all that is showing.
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
 * A `{code, params}` value translates via `code`; anything else falls back to
 * its raw message, then to `fallbackKey`. Degrade, never blank.
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

/** Shared by init recovery, polling recovery and a live extraction. */
function presentResult(data) {
    extractedData = data;
    view.setStepMode(stepModeForTransport(data.meta?.transport));
    setView('result');
    view.renderExtractionResult(data);
}

// ── Language ───────────────────────────────────────────────────────

/** Applied before the first render. */
export async function initI18n() {
    await I18n.init({ getStoredLanguage, detectLanguage, setStoredLanguage });
    view.setSelectedLanguage(I18n.getLanguage());
    view.applyStaticI18n();
}

/**
 * Re-renders only the visible state with the same data, so an in-flight
 * extraction's timers and a shown result's data survive the switch.
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

// ── Embed-images toggle ────────────────────────────────────────────
// Default ON. The checkbox is the escape hatch for a paste target that
// rejects data: URIs, not the expected case.

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
            // The fetch tiers never navigate the tab, so a popup that had
            // to poll back in means the tabnav fallback fired.
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
                // Slides has no working extraction path — do not start a
                // pipeline that can only fail.
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
        // The button is already disabled in init(); this is the backstop.
        view.showNotification(I18n.t('error.slidesUnsupported'), 'error');
        return;
    }

    view.beginExtractionUI();

    // Docs and Sheets both default to a transport that never touches the
    // tab, so the result arrives in this one response. tabnav runs only if
    // every fetch tier fails, and the display switches below once we know.
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

        // If every tier failed the pipeline fell back to tabnav, and
        // meta.warnings says so. presentResult() picks the step layout from
        // meta.transport.
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
