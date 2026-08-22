/**
 * Popup bootstrap: wire listeners, kick off init. An ES module, per
 * popup.html's `type="module"`.
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
// First, so nothing renders untranslated even for an instant.

await controller.initI18n();
controller.initEmbedImagesToggle();
controller.init();
