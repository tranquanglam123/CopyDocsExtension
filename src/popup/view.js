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

import { WARNINGS, WARNING_PREFIXES } from '../lib/const.js';
import { I18n } from '../lib/i18n/index.js';

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
const langSelect = document.getElementById('lang-select');

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
    langSelect,
};

// ── i18n (spec v3 §5) ──────────────────────────────────────────────

/** Fill every [data-i18n]/[data-i18n-title]/[data-i18n-aria-label] element. */
export function applyStaticI18n() {
    I18n.apply(document);
}

/** @returns {string} The language currently selected in the footer picker. */
export function getSelectedLanguage() {
    return langSelect.value;
}

/** @param {string} lang */
export function setSelectedLanguage(lang) {
    langSelect.value = lang;
}

// ── Warnings (meta.warnings from the extraction result) ───────────
// Never silent: an unrecognized warning code still renders verbatim
// instead of being swallowed.
//
// Codes come from shared/constants.js (spec v3 §4 T2) so a typo can't
// silently desync the popup from what the pipelines actually emit. Each
// maps to an i18n key (`warning.<code>`, spec v3 §5.4) rather than an
// English sentence, so it renders translated regardless of language.
// `low_confidence` and `multi_tab_partial` have no entry in
// shared/constants.js WARNINGS — they are not produced anywhere in the
// codebase today — so they stay as literal keys here rather than being
// invented in the shared constants file; both still have en/vi message
// keys (test/i18n.test.js only requires the constants.js-listed codes).

const WARNING_KEYS = {
    [WARNINGS.SINGLE_SHEET_ONLY]: 'warning.single_sheet_only',
    [WARNINGS.TABNAV_FALLBACK]: 'warning.tabnav_fallback',
    [WARNINGS.LEGACY_PARSER_FALLBACK]: 'warning.legacy_parser_fallback',
    [WARNINGS.STYLE_FILL_SKIPPED_SIZE]: 'warning.style_fill_skipped_size',
    [WARNINGS.CONTAINER_FALLBACK_USED]: 'warning.container_fallback_used',
    [WARNINGS.CONTAINER_NOT_FOUND]: 'warning.container_not_found',
    [WARNINGS.EMPTY_CONTENT]: 'warning.empty_content',
    [WARNINGS.IMAGE_BUDGET_EXCEEDED]: 'warning.image_budget_exceeded',
    low_confidence: 'warning.low_confidence',
    multi_tab_partial: 'warning.multi_tab_partial',
};

// Warning codes that carry a dynamic `:<n>` count suffix (spec §4.3) —
// matched by prefix, the count is interpolated as the `{count}` param.
const WARNING_PREFIX_KEYS = [
    { prefix: `${WARNING_PREFIXES.IMAGE_EMBED_FAILED}:`, key: 'warning.image_embed_failed' },
    { prefix: `${WARNING_PREFIXES.IMAGE_NOT_BITMAP}:`, key: 'warning.image_not_bitmap' },
];

/**
 * @param {string} code  A raw warning code from meta.warnings.
 * @returns {string} A human-readable, translated message — the code itself
 *   if unrecognized (never silent).
 */
function warningMessage(code) {
    if (WARNING_KEYS[code]) return I18n.t(WARNING_KEYS[code]);
    for (const { prefix, key } of WARNING_PREFIX_KEYS) {
        if (code.startsWith(prefix)) return I18n.t(key, { count: code.slice(prefix.length) });
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
        I18n.t('popup.status.extractionCompleteTitle'),
        I18n.t('popup.status.extractedDetail', { count: data.charCount.toLocaleString() }),
        'valid'
    );
    showWarnings(data.meta?.warnings);
    actionsExport.classList.remove('hidden');
    docxImageNote.classList.remove('hidden');
    btnExtract.disabled = true;
    showNotification(I18n.t('popup.notify.ready', { title: data.title }), 'success');
}

/** Popup reopened while a tabNav-fallback extraction is still running. */
export function renderRecoveryRunning() {
    progressSection.classList.remove('hidden');
    setStepMode('tabnav');
    setStep(2);
    setStatus('🔄', I18n.t('popup.status.recoveryTitle'), I18n.t('popup.status.recoveryDetail'));
    btnExtract.disabled = true;
}

export function renderSlidesUnsupported() {
    setStatus(
        '🚧',
        I18n.t('popup.status.slidesTitle'),
        I18n.t('popup.status.slidesDetail'),
        'invalid'
    );
    btnExtract.disabled = true;
}

/**
 * @param {string} type  A DOC_TYPES value ('docs'|'sheets'|'slides').
 * @param {string} url
 */
export function renderDocDetected(type, url) {
    setStatus('✅', I18n.t('popup.status.docDetected', { type: I18n.t(`docType.${type}`) }), truncateUrl(url), 'valid');
    btnExtract.disabled = false;
}

export function renderNotADoc() {
    setStatus('❌', I18n.t('popup.status.notADocTitle'), I18n.t('popup.status.notADocDetail'), 'invalid');
    btnExtract.disabled = true;
}

export function renderInitError(message) {
    setStatus('⚠️', I18n.t('popup.status.initErrorTitle'), message, 'invalid');
    btnExtract.disabled = true;
}

export function renderExtractionFailed(message) {
    setStatus('❌', I18n.t('popup.status.extractionFailedTitle'), message, 'invalid');
}
