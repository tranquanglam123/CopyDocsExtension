/**
 * Every DOM write the popup makes. Each function is a setter driven entirely
 * by its arguments; what state to be in is controller.js's decision.
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
const actionsOriginal = document.getElementById('actions-original');
const btnOriginal = document.getElementById('btn-original');
const actionsReset = document.getElementById('actions-reset');
const btnReset = document.getElementById('btn-reset');

const notification = document.getElementById('notification');
const notificationText = document.getElementById('notification-text');

const warningsBanner = document.getElementById('warnings-banner');
const warningsText = document.getElementById('warnings-text');

const chkEmbedImages = document.getElementById('chk-embed-images');
const langSelect = document.getElementById('lang-select');

/** Handles main.js needs for `addEventListener`. Every other node stays
 *  private to this module. */
export const elements = {
    btnExtract,
    btnCopy,
    btnNewDoc,
    btnDownloadDocx,
    btnDownloadTxt,
    btnOriginal,
    btnReset,
    chkEmbedImages,
    langSelect,
};

// ── i18n ───────────────────────────────────────────────────────────

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

// ── Warnings ──────────────────────────────────────────────────────
// Never silent: an unrecognized code renders verbatim. `low_confidence` and
// `multi_tab_partial` stay literal because nothing emits them yet.

const WARNING_KEYS = {
    [WARNINGS.SINGLE_SHEET_ONLY]: 'warning.single_sheet_only',
    [WARNINGS.TABNAV_FALLBACK]: 'warning.tabnav_fallback',
    [WARNINGS.LEGACY_PARSER_FALLBACK]: 'warning.legacy_parser_fallback',
    [WARNINGS.STYLE_FILL_SKIPPED_SIZE]: 'warning.style_fill_skipped_size',
    [WARNINGS.CONTAINER_FALLBACK_USED]: 'warning.container_fallback_used',
    [WARNINGS.CONTAINER_NOT_FOUND]: 'warning.container_not_found',
    [WARNINGS.EMPTY_CONTENT]: 'warning.empty_content',
    [WARNINGS.IMAGE_BUDGET_EXCEEDED]: 'warning.image_budget_exceeded',
    [WARNINGS.PAGE_ARTICLE_USED]: 'warning.page_article_used',
    [WARNINGS.LEGACY_VN_FONT]: 'warning.legacy_vn_font',
    [WARNINGS.PDF_RENDER_BUDGET_EXCEEDED]: 'warning.pdf_render_budget_exceeded',
    low_confidence: 'warning.low_confidence',
    multi_tab_partial: 'warning.multi_tab_partial',
};

// Codes carrying a `:<n>` suffix, matched by prefix; the count becomes the
// `{count}` param.
const WARNING_PREFIX_KEYS = [
    { prefix: `${WARNING_PREFIXES.IMAGE_EMBED_FAILED}:`, key: 'warning.image_embed_failed' },
    { prefix: `${WARNING_PREFIXES.IMAGE_NOT_BITMAP}:`, key: 'warning.image_not_bitmap' },
    { prefix: `${WARNING_PREFIXES.PDF_PAGES_AS_IMAGES}:`, key: 'warning.pdf_pages_as_images' },
    { prefix: `${WARNING_PREFIXES.DOCX_IMAGES_SKIPPED}:`, key: 'warning.docx_images_skipped' },
    { prefix: `${WARNING_PREFIXES.DOCX_EQUATIONS_CONVERTED}:`, key: 'warning.docx_equations_converted' },
    { prefix: `${WARNING_PREFIXES.DOCX_EQUATIONS_KEPT}:`, key: 'warning.docx_equations_kept' },
    { prefix: `${WARNING_PREFIXES.EMBED_FAILED}:`, key: 'warning.embed_failed' },
    { prefix: `${WARNING_PREFIXES.EMBEDS_OVER_LIMIT}:`, key: 'warning.embeds_over_limit' },
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

// ── Embed-images toggle ────────────────────────────────────────────

export function setEmbedImagesChecked(checked) {
    chkEmbedImages.checked = checked;
}

export function getEmbedImagesChecked() {
    return chkEmbedImages.checked;
}

// ── Step IDs ────────────────────────────────────────────────────
// Two sequences. The fetch tiers never touch the tab, so they have no
// "Block JS" / "Navigate" step; tabnav shows one when it fires.

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
// One named popup state each. Entering that state is the controller's
// decision; these only apply it.

/** Reset UI for a freshly started extraction. */
export function beginExtractionUI() {
    btnExtract.disabled = true;
    progressSection.classList.remove('hidden');
    actionsExport.classList.add('hidden');
    actionsOriginal.classList.add('hidden');
    actionsReset.classList.add('hidden');
    docxImageNote.classList.add('hidden');
    notification.classList.add('hidden');
    warningsBanner.classList.add('hidden');
}

/** Back to the state a freshly opened popup is in. */
export function clearResultUI() {
    progressSection.classList.add('hidden');
    actionsExport.classList.add('hidden');
    actionsOriginal.classList.add('hidden');
    actionsReset.classList.add('hidden');
    docxImageNote.classList.add('hidden');
    notification.classList.add('hidden');
    warningsBanner.classList.add('hidden');
    setStep(-1);
}

/** Render a completed extraction result. */
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
    actionsOriginal.classList.toggle('hidden', !data.meta?.sourceFiles?.length);
    actionsReset.classList.remove('hidden');
    docxImageNote.classList.remove('hidden');
    btnExtract.disabled = true;
    showNotification(I18n.t('popup.notify.ready', { title: data.title }), 'success');
}

/** Popup reopened while a tabnav-fallback extraction is still running. */
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

/**
 * @param {string} detail  What the page embeds, already worded.
 */
export function renderWebDetected(detail) {
    setStatus('✅', I18n.t('popup.status.docDetected', { type: I18n.t('docType.web') }), detail, 'valid');
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
