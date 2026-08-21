/**
 * popup-view.js — every DOM write the popup makes.
 *
 * This module owns all `document.getElementById` lookups and all element
 * mutation. It never calls `chrome.*` and never decides *what* to show —
 * every function here is a setter driven entirely by the arguments it is
 * given. The flow decisions (what state the popup is in, when to poll, when
 * to disable a button because of *why*) belong to popup-controller.js.
 *
 * Split out of entry/popup.js (spec v3 §4 P2) — same DOM ids, same classes,
 * same visual result, just relocated.
 */

import { WARNINGS, WARNING_PREFIXES } from '../shared/constants.js';

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

/**
 * The handful of elements the entry file needs handles to for
 * `addEventListener` — wiring listeners is entry/popup.js's job (spec v3
 * §4 P2), everything else about these nodes stays private to this module.
 */
export const elements = {
    btnExtract,
    btnCopy,
    btnNewDoc,
    btnDownloadDocx,
    btnDownloadTxt,
    chkEmbedImages,
};

// ── Warnings (meta.warnings from the extraction result) ───────────
// Never silent: an unrecognized warning code still renders verbatim
// instead of being swallowed.
//
// Codes come from shared/constants.js (spec v3 §4 T2) so a typo can't
// silently desync the popup from what the pipelines actually emit.
// `low_confidence` and `multi_tab_partial` have no entry in
// shared/constants.js WARNINGS — they are not produced anywhere in the
// codebase today — so they stay as literal keys here rather than being
// invented in the shared constants file.

const WARNING_MESSAGES = {
    [WARNINGS.SINGLE_SHEET_ONLY]: 'Only the first sheet was read (gid=0) — other sheets in this spreadsheet were not extracted.',
    low_confidence: 'Low-confidence extraction — the result may be incomplete.',
    multi_tab_partial: 'Multi-tab doc: only the first tab was extracted.',
    [WARNINGS.TABNAV_FALLBACK]: 'Direct fetch failed, so the extension fell back to the legacy method — your tab may have briefly navigated to the mobile view.',
    [WARNINGS.IMAGE_BUDGET_EXCEEDED]: 'Some images were too large to embed within the size budget, so they were left as links to Google Docs instead — they will only work while your session can reach them.',
    [WARNINGS.STYLE_FILL_SKIPPED_SIZE]: 'The formatted result was too large, so some computed styling was skipped — inline formatting from the source still applied.',
};

// Warning codes that carry a dynamic `:<n>` count suffix (spec §4.3) —
// matched by prefix so the count itself doesn't need a dictionary entry.
const WARNING_PREFIX_MESSAGES = [
    {
        prefix: `${WARNING_PREFIXES.IMAGE_EMBED_FAILED}:`,
        build: (n) => `${n} image${n === '1' ? '' : 's'} could not be fetched and were left as links to Google Docs instead of being embedded.`,
    },
    {
        prefix: `${WARNING_PREFIXES.IMAGE_NOT_BITMAP}:`,
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

export function showWarnings(warnings) {
    if (!warnings || warnings.length === 0) {
        warningsBanner.classList.add('hidden');
        warningsText.textContent = '';
        return;
    }
    warningsText.textContent = warnings.map(warningMessage).join(' ');
    warningsBanner.classList.remove('hidden');
}

// ── Embed-images toggle (spec §4.4) ────────────────────────────────

export function setEmbedImagesChecked(checked) {
    chkEmbedImages.checked = checked;
}

export function getEmbedImagesChecked() {
    return chkEmbedImages.checked;
}

// ── Step IDs ────────────────────────────────────────────────────
// Two sequences, matching what actually happens. The fetch transport
// (T1 swFetch / T2 csFetch — spec §3.2, pulled forward from P3) never
// touches the tab, so there's no "Block JS" / "Navigate" step to show for
// it. tabNav is now a last-resort fallback only, kept for when it fires
// (see entry/background.js dispatchTransport).

const STEPS_FETCH = ['step-validate', 'step-fetch', 'step-parse', 'step-done'];
const STEPS_TABNAV = ['step-validate', 'step-block', 'step-navigate', 'step-extract', 'step-done'];
const ALL_STEP_IDS = [...new Set([...STEPS_FETCH, ...STEPS_TABNAV])];

let activeSteps = STEPS_FETCH;

/**
 * Switch which step sequence is visible in the progress bar.
 * @param {'fetch'|'tabnav'} mode
 */
export function setStepMode(mode) {
    activeSteps = mode === 'tabnav' ? STEPS_TABNAV : STEPS_FETCH;
    ALL_STEP_IDS.forEach((id) => {
        document.getElementById(id).classList.toggle('hidden', !activeSteps.includes(id));
    });
}

export function setStep(stepIndex) {
    activeSteps.forEach((id, i) => {
        const el = document.getElementById(id);
        el.classList.remove('active', 'done');
        if (i < stepIndex) el.classList.add('done');
        if (i === stepIndex) el.classList.add('active');
    });
    progressFill.style.width = `${(stepIndex / (activeSteps.length - 1)) * 100}%`;
}

// ── Generic setters ─────────────────────────────────────────────

let notificationTimeoutId = null;

export function showNotification(text, type = 'info') {
    notification.className = `notification ${type}`;
    notificationText.textContent = text;
    notification.classList.remove('hidden');
    clearTimeout(notificationTimeoutId);
    notificationTimeoutId = setTimeout(() => {
        notification.classList.add('hidden');
    }, 5000);
}

export function setStatus(icon, title, detail, cardClass) {
    statusIcon.textContent = icon;
    statusTitle.textContent = title;
    statusDetail.textContent = detail || '';
    statusCard.className = `card status-card ${cardClass || ''}`;
}

export function setExtractButtonDisabled(disabled) {
    btnExtract.disabled = disabled;
}

function truncateUrl(url, max = 45) {
    if (!url || url.length <= max) return url;
    return url.substring(0, max) + '…';
}

// ── Composite renders ───────────────────────────────────────────
// Fixed DOM-write sequences ported verbatim from the original popup.js —
// each one renders a single, named popup state. The *decision* to enter
// that state still belongs to the controller; these only apply it.

/** Reset UI for a freshly started extraction (was inline in handleExtract). */
export function beginExtractionUI() {
    btnExtract.disabled = true;
    progressSection.classList.remove('hidden');
    actionsExport.classList.add('hidden');
    docxImageNote.classList.add('hidden');
    notification.classList.add('hidden');
    warningsBanner.classList.add('hidden');
}

/** Render a completed extraction result (was showExtractionResult). */
export function renderExtractionResult(data) {
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

/** Popup reopened while a tabNav-fallback extraction is still running. */
export function renderRecoveryRunning() {
    progressSection.classList.remove('hidden');
    setStepMode('tabnav');
    setStep(2);
    setStatus('🔄', 'Extracting…', 'Waiting for content extraction…');
    btnExtract.disabled = true;
}

export function renderSlidesUnsupported() {
    setStatus(
        '🚧',
        'Google Slides not supported yet',
        'Slides extraction isn\'t available in this version — try a Doc or Sheet instead.',
        'invalid'
    );
    btnExtract.disabled = true;
}

export function renderDocDetected(typeLabel, url) {
    setStatus('✅', `${typeLabel} detected`, truncateUrl(url), 'valid');
    btnExtract.disabled = false;
}

export function renderNotADoc() {
    setStatus('❌', 'Not a Google Doc', 'Navigate to a Google Doc, Sheet, or Slide.', 'invalid');
    btnExtract.disabled = true;
}

export function renderInitError(message) {
    setStatus('⚠️', 'Error', message, 'invalid');
    btnExtract.disabled = true;
}

export function renderExtractionFailed(message) {
    setStatus('❌', 'Extraction Failed', message, 'invalid');
}
