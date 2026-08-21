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

import * as view from '../ui/popup-view.js';
import * as controller from '../ui/popup-controller.js';

// ── Event Listeners ──────────────────────────────────────────────

view.elements.btnExtract.addEventListener('click', controller.handleExtract);
view.elements.btnCopy.addEventListener('click', controller.handleCopy);
view.elements.btnNewDoc.addEventListener('click', controller.handleNewDoc);
view.elements.btnDownloadDocx.addEventListener('click', controller.handleDownloadDocx);
view.elements.btnDownloadTxt.addEventListener('click', controller.handleDownloadTxt);
view.elements.chkEmbedImages.addEventListener('change', controller.handleEmbedImagesChange);

// ── Boot ─────────────────────────────────────────────────────────

controller.initEmbedImagesToggle();
controller.init();
