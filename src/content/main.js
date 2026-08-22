/**
 * Content script for /mobilebasic pages. Readiness detection only — the
 * offscreen document is the single parser, so its failure is fatal here.
 *
 * MV3 content scripts are not ES modules, so this is a plain IIFE and the
 * literals below cannot come from lib/const.js.
 */
(() => {
    'use strict';

    /**
     * Readiness detector (fixes D5 — replaces the fixed `setTimeout(500)`).
     * Polls `document.body.textContent.length` every 250ms, backed by a
     * MutationObserver; "ready" is 2 consecutive stable polls after a
     * 300ms minimum wait, capped at 10s so a page that keeps mutating is
     * never waited on forever.
     * @returns {Promise<void>}
     */
    function waitForReady() {
        return new Promise((resolve) => {
            const POLL_MS = 250;
            const MIN_WAIT_MS = 300;
            const HARD_CAP_MS = 10000;

            const start = Date.now();
            let lastLength = -1;
            let stableCount = 0;
            let mutatedSinceLastPoll = true; // unsettled until proven otherwise
            let settled = false;
            let pollTimer = null;
            let observer = null;

            const finish = () => {
                if (settled) return;
                settled = true;
                if (pollTimer) clearInterval(pollTimer);
                if (observer) observer.disconnect();
                resolve();
            };

            const check = () => {
                const elapsed = Date.now() - start;
                const length = document.body ? document.body.textContent.length : 0;
                const mutated = mutatedSinceLastPoll;
                mutatedSinceLastPoll = false;

                if (elapsed >= HARD_CAP_MS) {
                    finish();
                    return;
                }

                if (length === lastLength && !mutated) {
                    stableCount += 1;
                } else {
                    stableCount = 0;
                    lastLength = length;
                }

                if (elapsed >= MIN_WAIT_MS && stableCount >= 2) {
                    finish();
                }
            };

            if (typeof MutationObserver !== 'undefined' && document.body) {
                observer = new MutationObserver(() => {
                    mutatedSinceLastPoll = true;
                });
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                    attributes: true,
                });
            }

            pollTimer = setInterval(check, POLL_MS);
        });
    }

    if (window.location.href.includes('/mobilebasic')) {
        waitForReady().then(() => {
            // Ship the raw markup, including <head>, so the offscreen
            // parser can rebuild a real CSS cascade and recover Google's
            // class-based formatting (D2). No in-page fallback exists.
            chrome.runtime.sendMessage({
                action: 'contentReady',
                data: {
                    rawHtml: document.documentElement.outerHTML,
                    title: document.title,
                    url: window.location.href,
                    docType: 'docs',
                },
            });
        });
    }
})();
