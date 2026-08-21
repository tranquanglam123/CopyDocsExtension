/**
 * popup.js — UI logic for the CopyDocExt popup.
 *
 * Handles rich clipboard copy (HTML + plain), Open in New Doc,
 * .docx and .txt downloads, and popup-close recovery via storage polling.
 *
 * IMPORTANT: This is an ES module (type="module" in popup.html).
 * DOCX generation runs HERE, not in the service worker, because it
 * requires DOM APIs (DOMParser, Node, etc.) that don't exist in SW.
 */

import { DocxGenerator } from '../core/docx-generator.js';

// ── DOM references ───────────────────────────────────────────────

const statusCard = document.getElementById('status-card');
const statusIcon = document.getElementById('status-icon');
const statusTitle = document.getElementById('status-title');
const statusDetail = document.getElementById('status-detail');

const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');

const btnExtract = document.getElementById('btn-extract');
const actionsExport = document.getElementById('actions-export');
const btnCopy = document.getElementById('btn-copy');
const btnNewDoc = document.getElementById('btn-new-doc');
const btnDownloadDocx = document.getElementById('btn-download-docx');
const btnDownloadTxt = document.getElementById('btn-download-txt');
const docxImageNote = document.getElementById('docx-image-note');

const notification = document.getElementById('notification');
const notificationText = document.getElementById('notification-text');

const warningsBanner = document.getElementById('warnings-banner');
const warningsText = document.getElementById('warnings-text');

const chkEmbedImages = document.getElementById('chk-embed-images');

// ── State ────────────────────────────────────────────────────────

let extractedData = null;
let currentDocTitle = 'document';
let currentDocType = null;
let pollTimer = null;

// ── Settings (chrome.storage.local — persist across restarts) ─────
// Key mirrors ImageEmbedSettings.STORAGE_KEY in background/service-worker.js.

const EMBED_IMAGES_STORAGE_KEY = 'embedImagesEnabled';

// ── Warnings (meta.warnings from the extraction result) ───────────
// Never silent: an unrecognized warning code still renders verbatim
// instead of being swallowed.

const WARNING_MESSAGES = {
    single_sheet_only: 'Only the first sheet was read (gid=0) — other sheets in this spreadsheet were not extracted.',
    low_confidence: 'Low-confidence extraction — the result may be incomplete.',
    multi_tab_partial: 'Multi-tab doc: only the first tab was extracted.',
    tabnav_fallback: 'Direct fetch failed, so the extension fell back to the legacy method — your tab may have briefly navigated to the mobile view.',
    image_budget_exceeded: 'Some images were too large to embed within the size budget, so they were left as links to Google Docs instead — they will only work while your session can reach them.',
    style_fill_skipped_size: 'The formatted result was too large, so some computed styling was skipped — inline formatting from the source still applied.',
};

// Warning codes that carry a dynamic `:<n>` count suffix (spec §4.3) —
// matched by prefix so the count itself doesn't need a dictionary entry.
const WARNING_PREFIX_MESSAGES = [
    {
        prefix: 'image_embed_failed:',
        build: (n) => `${n} image${n === '1' ? '' : 's'} could not be fetched and were left as links to Google Docs instead of being embedded.`,
    },
    {
        prefix: 'image_not_bitmap:',
        build: (n) => `${n} image${n === '1' ? '' : 's'} could not be embedded because the source wasn't actually a picture (e.g. a viewer page, not a bitmap) — left as a link instead.`,
    },
];

/**
 * @param {string} code  A raw warning code from meta.warnings.
 * @returns {string} A human-readable message — the code itself if unrecognized (never silent).
 */
function warningMessage(code) {
    if (WARNING_MESSAGES[code]) return WARNING_MESSAGES[code];
    for (const { prefix, build } of WARNING_PREFIX_MESSAGES) {
        if (code.startsWith(prefix)) return build(code.slice(prefix.length));
    }
    return code;
}

function showWarnings(warnings) {
    if (!warnings || warnings.length === 0) {
        warningsBanner.classList.add('hidden');
        warningsText.textContent = '';
        return;
    }
    warningsText.textContent = warnings.map(warningMessage).join(' ');
    warningsBanner.classList.remove('hidden');
}

// ── Embed-images toggle (spec §4.4) ────────────────────────────────
// Default ON — whether Google Docs accepts data: URI images on paste is
// unverified (spec §8), so this checkbox is the escape hatch, not the
// expected common case.

async function initEmbedImagesToggle() {
    try {
        const stored = await chrome.storage.local.get(EMBED_IMAGES_STORAGE_KEY);
        const value = stored[EMBED_IMAGES_STORAGE_KEY];
        chkEmbedImages.checked = value === undefined ? true : !!value;
    } catch (err) {
        console.warn('[Popup] Could not read embed-images setting, defaulting to ON:', err);
        chkEmbedImages.checked = true;
    }

    chkEmbedImages.addEventListener('change', async () => {
        try {
            await chrome.storage.local.set({ [EMBED_IMAGES_STORAGE_KEY]: chkEmbedImages.checked });
        } catch (err) {
            console.error('[Popup] Failed to persist embed-images setting:', err);
        }
    });
}

// ── Step IDs ────────────────────────────────────────────────────
// Two sequences, matching what actually happens. The fetch transport
// (T1 swFetch / T2 csFetch — spec §3.2, pulled forward from P3) never
// touches the tab, so there's no "Block JS" / "Navigate" step to show for
// it. tabNav is now a last-resort fallback only, kept for when it fires
// (see background/service-worker.js dispatchTransport).

const STEPS_FETCH = ['step-validate', 'step-fetch', 'step-parse', 'step-done'];
const STEPS_TABNAV = ['step-validate', 'step-block', 'step-navigate', 'step-extract', 'step-done'];
const ALL_STEP_IDS = [...new Set([...STEPS_FETCH, ...STEPS_TABNAV])];

let activeSteps = STEPS_FETCH;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Switch which step sequence is visible in the progress bar.
 * @param {'fetch'|'tabnav'} mode
 */
function setStepMode(mode) {
    activeSteps = mode === 'tabnav' ? STEPS_TABNAV : STEPS_FETCH;
    ALL_STEP_IDS.forEach((id) => {
        document.getElementById(id).classList.toggle('hidden', !activeSteps.includes(id));
    });
}

function setStep(stepIndex) {
    activeSteps.forEach((id, i) => {
        const el = document.getElementById(id);
        el.classList.remove('active', 'done');
        if (i < stepIndex) el.classList.add('done');
        if (i === stepIndex) el.classList.add('active');
    });
    progressFill.style.width = `${(stepIndex / (activeSteps.length - 1)) * 100}%`;
}

function showNotification(text, type = 'info') {
    notification.className = `notification ${type}`;
    notificationText.textContent = text;
    notification.classList.remove('hidden');
    clearTimeout(showNotification._timeout);
    showNotification._timeout = setTimeout(() => {
        notification.classList.add('hidden');
    }, 5000);
}

function setStatus(icon, title, detail, cardClass) {
    statusIcon.textContent = icon;
    statusTitle.textContent = title;
    statusDetail.textContent = detail || '';
    statusCard.className = `card status-card ${cardClass || ''}`;
}

function showExtractionResult(data) {
    extractedData = data;
    progressSection.classList.remove('hidden');
    setStep(activeSteps.length - 1);
    setStatus(
        '✅',
        'Extraction Complete',
        `${data.charCount.toLocaleString()} characters extracted`,
        'valid'
    );
    showWarnings(data.meta?.warnings);
    actionsExport.classList.remove('hidden');
    docxImageNote.classList.remove('hidden');
    btnExtract.disabled = true;
    showNotification(`"${data.title}" ready — copy, open in new doc, or download!`, 'success');
}

function truncateUrl(url, max = 45) {
    if (!url || url.length <= max) return url;
    return url.substring(0, max) + '…';
}

// ── Init ─────────────────────────────────────────────────────────

async function init() {
    try {
        // Check for completed or running extraction (popup recovery)
        const statusResp = await chrome.runtime.sendMessage({ action: 'getExtractionStatus' });

        if (statusResp?.status === 'complete' && statusResp.data) {
            setStepMode(statusResp.data.meta?.transport === 'tabNav' ? 'tabnav' : 'fetch');
            showExtractionResult(statusResp.data);
            return;
        }

        if (statusResp?.status === 'running') {
            progressSection.classList.remove('hidden');
            // The fetch transport (T1/T2) never navigates the tab, so it
            // can't be the reason the popup needed recovering — a popup
            // that had to poll back in almost certainly means the tabNav
            // fallback fired and navigated the tab out from under it.
            setStepMode('tabnav');
            setStep(2);
            setStatus('🔄', 'Extracting…', 'Waiting for content extraction…');
            btnExtract.disabled = true;
            startPolling();
            return;
        }

        // Normal init — check if current tab is a Google Doc
        const response = await chrome.runtime.sendMessage({ action: 'checkTab' });

        if (response?.success && response.data.isValid) {
            currentDocTitle = response.data.title || 'document';
            currentDocType = response.data.type;

            if (response.data.type === 'slides') {
                // D1: Slides has no working extraction path in P1 — don't
                // let the user start a pipeline that can only fail.
                setStatus(
                    '🚧',
                    'Google Slides not supported yet',
                    'Slides extraction isn\'t available in this version — try a Doc or Sheet instead.',
                    'invalid'
                );
                btnExtract.disabled = true;
            } else {
                setStatus(
                    '✅',
                    `${response.data.typeLabel} detected`,
                    truncateUrl(response.data.url),
                    'valid'
                );
                btnExtract.disabled = false;
            }
        } else {
            setStatus('❌', 'Not a Google Doc', 'Navigate to a Google Doc, Sheet, or Slide.', 'invalid');
            btnExtract.disabled = true;
        }
    } catch (err) {
        setStatus('⚠️', 'Error', err.message, 'invalid');
        btnExtract.disabled = true;
    }
}

// ── Polling ──────────────────────────────────────────────────────

function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        try {
            const resp = await chrome.runtime.sendMessage({ action: 'getExtractionStatus' });
            if (resp?.status === 'complete' && resp.data) {
                stopPolling();
                setStepMode(resp.data.meta?.transport === 'tabNav' ? 'tabnav' : 'fetch');
                showExtractionResult(resp.data);
            } else if (resp?.status === 'error') {
                stopPolling();
                setStatus('❌', 'Extraction Failed', resp.error || 'Check the browser console for details.', 'invalid');
                btnExtract.disabled = (currentDocType !== 'slides') ? false : true;
            }
        } catch { /* keep polling */ }
    }, 1000);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Extract ──────────────────────────────────────────────────────

async function handleExtract() {
    if (currentDocType === 'slides') {
        // Defensive — the button should already be disabled (see init()),
        // but never let this fall through to a pipeline that can't work.
        showNotification('Google Slides not supported yet.', 'error');
        return;
    }

    btnExtract.disabled = true;
    progressSection.classList.remove('hidden');
    actionsExport.classList.add('hidden');
    docxImageNote.classList.add('hidden');
    notification.classList.add('hidden');
    warningsBanner.classList.add('hidden');

    // Docs and Sheets both default to a transport that never touches the
    // tab now (Docs: swFetch/csFetch, spec §3.2; Sheets: swFetch,
    // unchanged) — the tab is never navigated, and the popup gets its
    // result straight from this one response instead of via a
    // navigation-triggered close/reopen. tabNav only runs as an explicit
    // last-resort fallback if every fetch tier fails; if it does, we
    // switch the display below once we know.
    setStepMode('fetch');

    try {
        setStep(0);
        setStatus('🔄', 'Extracting…', 'Validating document URL');
        await delay(300);

        setStep(1);
        if (currentDocType === 'sheets') {
            setStatus('🔄', 'Extracting…', 'Fetching spreadsheet data directly — no tab navigation needed');
        } else {
            setStatus('🔄', 'Extracting…', 'Fetching document HTML directly — no tab navigation needed');
        }
        await delay(300);

        setStep(2);
        setStatus('🔄', 'Extracting…', 'Parsing document formatting');

        startPolling();

        const response = await chrome.runtime.sendMessage({ action: 'startExtraction' });

        stopPolling();

        if (!response?.success) {
            throw new Error(response?.error || 'Extraction failed.');
        }

        if (response.data?.meta?.transport === 'tabNav') {
            // Every fetch tier failed and the background pipeline fell
            // back to the legacy block-JS + navigate path (meta.warnings
            // carries 'tabnav_fallback', surfaced via the warnings banner
            // below). The extraction has already finished by the time we
            // learn this, so just switch to the matching 5-step layout
            // before showing the result.
            setStepMode('tabnav');
        }

        showExtractionResult(response.data);

    } catch (err) {
        stopPolling();
        console.error('[Popup]', err);
        setStatus('❌', 'Extraction Failed', err.message, 'invalid');
        showNotification(err.message, 'error');
        btnExtract.disabled = false;
    }
}

// ── Copy with formatting ─────────────────────────────────────────

async function handleCopy() {
    if (!extractedData) return;

    try {
        // Rich copy: HTML (for Google Docs / Word paste) + plain text fallback
        const htmlBlob = new Blob([extractedData.html], { type: 'text/html' });
        const textBlob = new Blob([extractedData.text], { type: 'text/plain' });

        await navigator.clipboard.write([
            new ClipboardItem({
                'text/html': htmlBlob,
                'text/plain': textBlob,
            }),
        ]);
        showNotification('Copied with formatting! Paste into Google Docs or Word.', 'success');
    } catch (err) {
        console.warn('[Popup] ClipboardItem failed, using text fallback:', err);
        // Fallback: plain text only
        try {
            await navigator.clipboard.writeText(extractedData.text);
            showNotification('Copied as plain text (rich copy not supported here).', 'info');
        } catch {
            const ta = document.createElement('textarea');
            ta.value = extractedData.text;
            ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showNotification('Copied as plain text (fallback).', 'info');
        }
    }
}

// ── Open in New Google Doc ────────────────────────────────────────

async function handleNewDoc() {
    if (!extractedData) return;

    // First, copy with formatting to clipboard
    await handleCopy();

    // Then open a new Google Doc
    try {
        await chrome.runtime.sendMessage({ action: 'openNewDoc' });
        showNotification('New doc opened! Press Ctrl+V to paste your formatted content.', 'info');
    } catch (err) {
        showNotification(`Could not open new doc: ${err.message}`, 'error');
    }
}

// ── Download .docx (Office 2007+) ──────────────────────────────────
// Generated HERE in the popup (not service worker) because
// DocxGenerator uses DOMParser / Node — unavailable in service workers.

async function handleDownloadDocx() {
    if (!extractedData) return;

    const filename = sanitizeFilename(extractedData.title || currentDocTitle) + '.docx';

    try {
        // Generate .docx blob locally (popup has DOM APIs)
        const blob = DocxGenerator.generate(
            extractedData.bodyHtml,
            extractedData.title || currentDocTitle
        );

        // Convert blob to data URL for chrome.downloads
        const dataUrl = await blobToDataUrl(blob);

        chrome.downloads.download(
            { url: dataUrl, filename, saveAs: true },
            (downloadId) => {
                if (chrome.runtime.lastError) {
                    showNotification(`Download failed: ${chrome.runtime.lastError.message}`, 'error');
                } else {
                    showNotification(`Downloading "${filename}" — opens in Word & Google Docs!`, 'success');
                }
            }
        );
    } catch (err) {
        console.error('[Popup] DOCX generation error:', err);
        showNotification(`Download failed: ${err.message}`, 'error');
    }
}

// ── Download .txt ────────────────────────────────────────────────

async function handleDownloadTxt() {
    if (!extractedData?.text) return;

    const filename = sanitizeFilename(extractedData.title || currentDocTitle) + '.txt';

    try {
        const resp = await chrome.runtime.sendMessage({
            action: 'download',
            text: extractedData.text,
            filename,
            mimeType: 'text/plain',
        });
        if (resp?.success) {
            showNotification(`Downloading "${filename}"`, 'success');
        } else {
            throw new Error(resp?.error || 'Download failed.');
        }
    } catch (err) {
        showNotification(`Download failed: ${err.message}`, 'error');
    }
}

// ── Utils ────────────────────────────────────────────────────────

function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 100);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
    });
}

// ── Event Listeners ──────────────────────────────────────────────

btnExtract.addEventListener('click', handleExtract);
btnCopy.addEventListener('click', handleCopy);
btnNewDoc.addEventListener('click', handleNewDoc);
btnDownloadDocx.addEventListener('click', handleDownloadDocx);
btnDownloadTxt.addEventListener('click', handleDownloadTxt);

// ── Boot ─────────────────────────────────────────────────────────

initEmbedImagesToggle();
init();

