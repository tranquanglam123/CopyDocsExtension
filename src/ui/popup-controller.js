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

import { LOCAL_KEYS, EXTRACTION_STATUS, TRANSPORTS, DOC_TYPES } from '../shared/constants.js';
import * as view from './popup-view.js';
import * as exportsApi from './popup-exports.js';

// ── State ────────────────────────────────────────────────────────

let extractedData = null;
let currentDocTitle = 'document';
let currentDocType = null;
let pollTimer = null;

function stepModeForTransport(transport) {
    return transport === TRANSPORTS.TAB_NAV ? 'tabnav' : 'fetch';
}

/** Store the result and render it — shared by init recovery, polling recovery, and a live extraction. */
function presentResult(data) {
    extractedData = data;
    view.setStepMode(stepModeForTransport(data.meta?.transport));
    view.renderExtractionResult(data);
}

// ── Embed-images toggle (spec §4.4) ────────────────────────────────
// Default ON — whether Google Docs accepts data: URI images on paste is
// unverified (spec §8), so this checkbox is the escape hatch, not the
// expected common case.

export async function initEmbedImagesToggle() {
    try {
        const stored = await chrome.storage.local.get(LOCAL_KEYS.EMBED_IMAGES);
        const value = stored[LOCAL_KEYS.EMBED_IMAGES];
        view.setEmbedImagesChecked(value === undefined ? true : !!value);
    } catch (err) {
        console.warn('[Popup] Could not read embed-images setting, defaulting to ON:', err);
        view.setEmbedImagesChecked(true);
    }
}

export async function handleEmbedImagesChange() {
    try {
        await chrome.storage.local.set({ [LOCAL_KEYS.EMBED_IMAGES]: view.getEmbedImagesChecked() });
    } catch (err) {
        console.error('[Popup] Failed to persist embed-images setting:', err);
    }
}

// ── Init ─────────────────────────────────────────────────────────

export async function init() {
    try {
        // Check for completed or running extraction (popup recovery)
        const statusResp = await chrome.runtime.sendMessage({ action: 'getExtractionStatus' });

        if (statusResp?.status === EXTRACTION_STATUS.COMPLETE && statusResp.data) {
            presentResult(statusResp.data);
            return;
        }

        if (statusResp?.status === EXTRACTION_STATUS.RUNNING) {
            // The fetch transport (T1/T2) never navigates the tab, so it
            // can't be the reason the popup needed recovering — a popup
            // that had to poll back in almost certainly means the tabNav
            // fallback fired and navigated the tab out from under it.
            view.renderRecoveryRunning();
            startPolling();
            return;
        }

        // Normal init — check if current tab is a Google Doc
        const response = await chrome.runtime.sendMessage({ action: 'checkTab' });

        if (response?.success && response.data.isValid) {
            currentDocTitle = response.data.title || 'document';
            currentDocType = response.data.type;

            if (response.data.type === DOC_TYPES.SLIDES) {
                // D1: Slides has no working extraction path in P1 — don't
                // let the user start a pipeline that can only fail.
                view.renderSlidesUnsupported();
            } else {
                view.renderDocDetected(response.data.typeLabel, response.data.url);
            }
        } else {
            view.renderNotADoc();
        }
    } catch (err) {
        view.renderInitError(err.message);
    }
}

// ── Polling ──────────────────────────────────────────────────────

export function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        try {
            const resp = await chrome.runtime.sendMessage({ action: 'getExtractionStatus' });
            if (resp?.status === EXTRACTION_STATUS.COMPLETE && resp.data) {
                stopPolling();
                presentResult(resp.data);
            } else if (resp?.status === EXTRACTION_STATUS.ERROR) {
                stopPolling();
                view.renderExtractionFailed(resp.error || 'Check the browser console for details.');
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
        view.showNotification('Google Slides not supported yet.', 'error');
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
        view.setStatus('🔄', 'Extracting…', 'Validating document URL');
        await delay(300);

        view.setStep(1);
        if (currentDocType === DOC_TYPES.SHEETS) {
            view.setStatus('🔄', 'Extracting…', 'Fetching spreadsheet data directly — no tab navigation needed');
        } else {
            view.setStatus('🔄', 'Extracting…', 'Fetching document HTML directly — no tab navigation needed');
        }
        await delay(300);

        view.setStep(2);
        view.setStatus('🔄', 'Extracting…', 'Parsing document formatting');

        startPolling();

        const response = await chrome.runtime.sendMessage({ action: 'startExtraction' });

        stopPolling();

        if (!response?.success) {
            throw new Error(response?.error || 'Extraction failed.');
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
        view.showNotification('Copied with formatting! Paste into Google Docs or Word.', 'success');
    } else if (mode === 'plain') {
        view.showNotification('Copied as plain text (rich copy not supported here).', 'info');
    } else {
        view.showNotification('Copied as plain text (fallback).', 'info');
    }
}

// ── Open in New Google Doc ────────────────────────────────────────

export async function handleNewDoc() {
    if (!extractedData) return;

    // First, copy with formatting to clipboard
    await handleCopy();

    // Then open a new Google Doc
    try {
        await chrome.runtime.sendMessage({ action: 'openNewDoc' });
        view.showNotification('New doc opened! Press Ctrl+V to paste your formatted content.', 'info');
    } catch (err) {
        view.showNotification(`Could not open new doc: ${err.message}`, 'error');
    }
}

// ── Download .docx (Office 2007+) ──────────────────────────────────

export async function handleDownloadDocx() {
    if (!extractedData) return;

    const filename = exportsApi.sanitizeFilename(extractedData.title || currentDocTitle) + '.docx';

    try {
        await exportsApi.downloadDocx(extractedData.bodyHtml, extractedData.title || currentDocTitle, filename);
        view.showNotification(`Downloading "${filename}" — opens in Word & Google Docs!`, 'success');
    } catch (err) {
        console.error('[Popup] DOCX generation error:', err);
        view.showNotification(`Download failed: ${err.message}`, 'error');
    }
}

// ── Download .txt ────────────────────────────────────────────────

export async function handleDownloadTxt() {
    if (!extractedData?.text) return;

    const filename = exportsApi.sanitizeFilename(extractedData.title || currentDocTitle) + '.txt';

    try {
        await exportsApi.downloadTxt(extractedData.text, filename, 'text/plain');
        view.showNotification(`Downloading "${filename}"`, 'success');
    } catch (err) {
        view.showNotification(`Download failed: ${err.message}`, 'error');
    }
}

// ── Utils ────────────────────────────────────────────────────────

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
