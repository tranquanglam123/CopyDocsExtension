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

import { DocxGenerator } from '../lib/docx-generator.js';

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

const notification = document.getElementById('notification');
const notificationText = document.getElementById('notification-text');

// ── State ────────────────────────────────────────────────────────

let extractedData = null;
let currentDocTitle = 'document';
let pollTimer = null;

// ── Step IDs ────────────────────────────────────────────────────

const STEPS = ['step-validate', 'step-block', 'step-navigate', 'step-extract', 'step-done'];

// ── Helpers ──────────────────────────────────────────────────────

function setStep(stepIndex) {
    STEPS.forEach((id, i) => {
        const el = document.getElementById(id);
        el.classList.remove('active', 'done');
        if (i < stepIndex) el.classList.add('done');
        if (i === stepIndex) el.classList.add('active');
    });
    progressFill.style.width = `${(stepIndex / (STEPS.length - 1)) * 100}%`;
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
    setStep(4);
    setStatus(
        '✅',
        'Extraction Complete',
        `${data.charCount.toLocaleString()} characters extracted`,
        'valid'
    );
    actionsExport.classList.remove('hidden');
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
            showExtractionResult(statusResp.data);
            return;
        }

        if (statusResp?.status === 'running') {
            progressSection.classList.remove('hidden');
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
            setStatus(
                '✅',
                `${response.data.typeLabel} detected`,
                truncateUrl(response.data.url),
                'valid'
            );
            btnExtract.disabled = false;
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
                showExtractionResult(resp.data);
            } else if (resp?.status === 'error') {
                stopPolling();
                setStatus('❌', 'Extraction Failed', 'Check the browser console for details.', 'invalid');
                btnExtract.disabled = false;
            }
        } catch { /* keep polling */ }
    }, 1000);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Extract ──────────────────────────────────────────────────────

async function handleExtract() {
    btnExtract.disabled = true;
    progressSection.classList.remove('hidden');
    actionsExport.classList.add('hidden');
    notification.classList.add('hidden');

    try {
        setStep(0);
        setStatus('🔄', 'Extracting…', 'Validating document URL');
        await delay(300);

        setStep(1);
        setStatus('🔄', 'Extracting…', 'Blocking JavaScript on tab');
        await delay(300);

        setStep(2);
        setStatus('🔄', 'Extracting…', 'Navigating to mobile view — popup may close briefly');

        startPolling();

        const response = await chrome.runtime.sendMessage({ action: 'startExtraction' });

        stopPolling();

        if (!response?.success) {
            throw new Error(response?.error || 'Extraction failed.');
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

init();

