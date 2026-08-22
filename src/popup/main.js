/**
 * popup.js — bootstrap for the CopyDocExt popup.
 *
 * IMPORTANT: This is an ES module (type="module" in popup.html).
 *
 * This file does nothing but wire DOM event listeners to controller
 * handlers and kick off init — every DOM write lives in ui/popup-view.js,
 * every flow/messaging decision lives in ui/popup-controller.js (spec v3
 * §4 P2).
 */

import * as view from './view.js';
import * as controller from './controller.js';

// ── Event Listeners ──────────────────────────────────────────────

view.elements.btnExtract.addEventListener('click', controller.handleExtract);
view.elements.btnCopy.addEventListener('click', controller.handleCopy);
view.elements.btnNewDoc.addEventListener('click', controller.handleNewDoc);
view.elements.btnDownloadDocx.addEventListener('click', controller.handleDownloadDocx);
view.elements.btnDownloadTxt.addEventListener('click', controller.handleDownloadTxt);
view.elements.chkEmbedImages.addEventListener('change', controller.handleEmbedImagesChange);
view.elements.langSelect.addEventListener('change', controller.handleLanguageChange);

// ── Boot ─────────────────────────────────────────────────────────
// i18n loads first (spec v3 §5) so nothing renders untranslated even for
// an instant — everything downstream of it (labels, statuses, errors)
// depends on I18n already having a dictionary loaded.

await controller.initI18n();
controller.initEmbedImagesToggle();
controller.init();
