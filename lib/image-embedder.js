/**
 * image-embedder.js — embed a document's own `docs.google.com` images as
 * inline `data:` URIs (spec §4).
 *
 * WHY: the six images in the user's real restricted Doc — one
 * `docs.google.com/drawings/d/…` (a red rounded title block) and five
 * `docs.google.com/docs-images-rt/…` (rendered equations/pictures) — sit
 * behind the user's cookies. A bare `<img src="https://docs.google.com/…">`
 * in the clipboard does not survive a paste into a different context, and
 * Google's own HTML importer cannot fetch a restricted document's assets on
 * the user's behalf. So each image is fetched through the same T1/T2
 * transport tiers used for the document HTML itself
 * (`lib/transport.js` `fetchBinary`) and rewritten in place to a
 * self-contained `data:` URI.
 *
 * This module has NO DOM dependency — it runs in the service worker, which
 * has none — and operates on `bodyHtml` as a string via regex, touching
 * only the `src="…"` portion of each `<img>` tag it rewrites. Every other
 * attribute (`width`, `height`, `style`, …) is left byte-for-byte alone,
 * which is what preserves sizing for the (deferred, v2.2) DOCX writer.
 *
 * Every failure mode here is non-fatal by design (spec §4.2): a fetch that
 * fails, times out, returns something that isn't a bitmap, or would blow a
 * size budget leaves the original `src` in place and adds a warning.
 * Losing an image must never lose the document.
 */

import { fetchBinary, isImageContentType } from './transport.js';

export class ImageEmbedder {

    /** Per-image decoded-size cap (spec §4.2). */
    static PER_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

    /** Total decoded-size budget across all images in one document (spec §4.2). */
    static TOTAL_BUDGET_BYTES = 12 * 1024 * 1024;

    /** Max simultaneous in-flight image fetches (spec §4.2). */
    static MAX_CONCURRENT = 4;

    /**
     * Per-image timeout applied here as well as inside the transport tiers
     * (spec §4.2 "8s timeout each") — belt-and-suspenders so a caller that
     * injects its own `fetchFn` (tests; or a future transport) can't stall
     * the whole embed pass just because it forgot to time out internally.
     */
    static TIMEOUT_MS = 8000;

    // ─── Entry point ────────────────────────────────────────────────────

    /**
     * Find every `<img>` whose `src` is a `docs.google.com` URL, fetch it,
     * and rewrite `src` to a `data:` URI in place. Never throws — every
     * failure degrades to "leave the original src, add a warning".
     *
     * @param {string} bodyHtml
     * @param {{
     *   tabId?: number,
     *   budgetBytes?: number,
     *   fetchFn?: (opts: {url: string, tabId?: number}) => Promise<{ok:boolean, base64:string, byteLength:number, contentType:string}>,
     *   maxConcurrent?: number,
     *   perImageMaxBytes?: number,
     *   timeoutMs?: number,
     * }} [opts]
     *   `fetchFn` defaults to `fetchBinary` from `lib/transport.js` (T1/T2).
     *   Overridable purely so `test/image-embedder.test.js` can exercise
     *   the collection/guard/budget logic under plain `node --test` without
     *   any Chrome API.
     * @returns {Promise<{bodyHtml: string, stats: {
     *   totalFound: number, embedded: number, notBitmap: number, failed: number,
     *   budgetExceeded: boolean, totalBytes: number, warnings: string[],
     * }}>}
     */
    static async embedImages(bodyHtml, opts = {}) {
        const {
            tabId,
            budgetBytes = ImageEmbedder.TOTAL_BUDGET_BYTES,
            fetchFn = fetchBinary,
            maxConcurrent = ImageEmbedder.MAX_CONCURRENT,
            perImageMaxBytes = ImageEmbedder.PER_IMAGE_MAX_BYTES,
            timeoutMs = ImageEmbedder.TIMEOUT_MS,
        } = opts;

        const stats = ImageEmbedder._emptyStats();

        if (typeof bodyHtml !== 'string' || bodyHtml.length === 0) {
            return { bodyHtml: bodyHtml || '', stats };
        }

        const images = ImageEmbedder.collectGoogleImages(bodyHtml);
        stats.totalFound = images.length;

        if (images.length === 0) {
            return { bodyHtml, stats };
        }

        const outcomes = await ImageEmbedder._fetchAll(images, {
            tabId, fetchFn, maxConcurrent, perImageMaxBytes, budgetBytes, timeoutMs,
        });

        const newBodyHtml = ImageEmbedder._applyOutcomes(bodyHtml, images, outcomes, stats);

        if (stats.failed > 0) stats.warnings.push(`image_embed_failed:${stats.failed}`);
        if (stats.notBitmap > 0) stats.warnings.push(`image_not_bitmap:${stats.notBitmap}`);
        if (stats.budgetExceeded) stats.warnings.push('image_budget_exceeded');

        console.log(
            `[ImageEmbedder] ${stats.embedded}/${stats.totalFound} embedded ` +
            `(not-bitmap: ${stats.notBitmap}, failed: ${stats.failed}, ` +
            `budgetExceeded: ${stats.budgetExceeded}), ${stats.totalBytes} bytes total.`
        );

        return { bodyHtml: newBodyHtml, stats };
    }

    // ─── Collection (pure) ──────────────────────────────────────────────

    /**
     * Collect every `<img src="…">` in `bodyHtml` whose `src` host is
     * exactly `docs.google.com`. Pure string/regex logic — no DOM, so this
     * is directly unit-testable under plain `node --test`.
     *
     * @param {string} bodyHtml
     * @returns {Array<{start: number, end: number, tag: string, src: string}>}
     *   `start`/`end` are character offsets of the whole `<img …>` tag in
     *   `bodyHtml`, in source order.
     */
    static collectGoogleImages(bodyHtml) {
        if (typeof bodyHtml !== 'string' || bodyHtml.length === 0) return [];

        const images = [];
        const imgTagRe = /<img\b[^>]*>/gi;
        let match;

        while ((match = imgTagRe.exec(bodyHtml)) !== null) {
            const tag = match[0];
            const src = ImageEmbedder._extractSrc(tag);
            if (src === null) continue;
            if (!ImageEmbedder._isDocsGoogleComSrc(src)) continue;

            images.push({
                start: match.index,
                end: match.index + tag.length,
                tag,
                src,
            });
        }

        return images;
    }

    /**
     * @param {string} tag  A single `<img …>` tag.
     * @returns {string|null}  The raw (unescaped-as-written) `src` value, or
     *   `null` if the tag has no `src` attribute.
     * @private
     */
    static _extractSrc(tag) {
        const match = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        if (!match) return null;
        return match[1] !== undefined ? match[1] : match[2];
    }

    /**
     * @param {string} src
     * @returns {boolean} True only for an absolute `docs.google.com` URL.
     * @private
     */
    static _isDocsGoogleComSrc(src) {
        if (!src || typeof src !== 'string') return false;
        let parsed;
        try {
            parsed = new URL(src);
        } catch {
            return false; // relative / malformed / already a data: URI, etc.
        }
        return parsed.hostname === 'docs.google.com';
    }

    // ─── Fetch + budget (needs fetchFn; pure given an injected one) ─────

    /**
     * Fetch every collected image (bounded concurrency) and decide the
     * outcome of each: 'embed' | 'not-bitmap' | 'budget' | 'budget-skip' | 'fail'.
     * Per-image and total budgets are enforced here — once either is hit,
     * every image not yet started is marked 'budget-skip' without being
     * fetched at all (spec §4.2 "over budget → keep the original URL, warn").
     *
     * @param {Array<{src: string}>} images
     * @param {{tabId?: number, fetchFn: Function, maxConcurrent: number, perImageMaxBytes: number, budgetBytes: number, timeoutMs: number}} cfg
     * @returns {Promise<Array<{action: string, mime?: string, base64?: string, byteLength?: number}>>}
     *   Same length/order as `images`.
     * @private
     */
    static async _fetchAll(images, cfg) {
        const { tabId, fetchFn, maxConcurrent, perImageMaxBytes, budgetBytes, timeoutMs } = cfg;
        const outcomes = new Array(images.length);

        let remainingBudget = budgetBytes;
        let budgetHit = false;
        let nextIndex = 0;

        async function processOne(i) {
            if (budgetHit) {
                outcomes[i] = { action: 'budget-skip' };
                return;
            }

            const image = images[i];
            let res;
            try {
                res = await ImageEmbedder._withTimeout(fetchFn({ url: image.src, tabId }), timeoutMs);
            } catch (err) {
                console.warn(`[ImageEmbedder] fetch threw for ${image.src}:`, err?.message || err);
                outcomes[i] = { action: 'fail' };
                return;
            }

            if (!res || !res.ok) {
                outcomes[i] = { action: 'fail' };
                return;
            }

            if (!isImageContentType(res.contentType)) {
                outcomes[i] = { action: 'not-bitmap' };
                return;
            }

            const byteLength = typeof res.byteLength === 'number' ? res.byteLength : 0;

            if (byteLength > perImageMaxBytes || byteLength > remainingBudget) {
                budgetHit = true;
                outcomes[i] = { action: 'budget' };
                return;
            }

            remainingBudget -= byteLength;
            const mime = (res.contentType || 'image/png').split(';')[0].trim();
            outcomes[i] = { action: 'embed', mime, base64: res.base64 || '', byteLength };
        }

        async function worker() {
            for (let i = nextIndex++; i < images.length; i = nextIndex++) {
                await processOne(i);
            }
        }

        const workerCount = Math.max(1, Math.min(maxConcurrent, images.length));
        await Promise.all(Array.from({ length: workerCount }, worker));

        return outcomes;
    }

    /**
     * @param {Promise<object>} promise
     * @param {number} ms
     * @returns {Promise<object>} Resolves (never rejects) to `{ok:false, timedOut:true}` on timeout.
     * @private
     */
    static _withTimeout(promise, ms) {
        if (!ms || ms <= 0) return Promise.resolve(promise);
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
        });
        return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
    }

    // ─── Apply outcomes back into bodyHtml (pure) ───────────────────────

    /**
     * Rebuild `bodyHtml` with each 'embed' outcome's `src` rewritten to a
     * `data:` URI, tallying `stats` as it goes. Every other outcome leaves
     * the original tag byte-for-byte untouched.
     *
     * @param {string} bodyHtml
     * @param {Array<{start:number, end:number, tag:string}>} images
     * @param {Array<{action:string, mime?:string, base64?:string, byteLength?:number}>} outcomes
     * @param {object} stats  Mutated in place.
     * @returns {string}
     * @private
     */
    static _applyOutcomes(bodyHtml, images, outcomes, stats) {
        let result = '';
        let cursor = 0;

        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            const outcome = outcomes[i] || { action: 'fail' };

            result += bodyHtml.slice(cursor, image.start);

            if (outcome.action === 'embed') {
                result += ImageEmbedder._rewriteSrc(image.tag, outcome.mime, outcome.base64);
                stats.embedded++;
                stats.totalBytes += outcome.byteLength || 0;
            } else {
                result += image.tag; // untouched — original src preserved
                if (outcome.action === 'not-bitmap') {
                    stats.notBitmap++;
                } else if (outcome.action === 'budget' || outcome.action === 'budget-skip') {
                    stats.budgetExceeded = true;
                } else {
                    stats.failed++;
                }
            }

            cursor = image.end;
        }

        result += bodyHtml.slice(cursor);
        return result;
    }

    /**
     * Replace only the `src="…"` portion of an `<img>` tag, leaving every
     * other attribute (`width`, `height`, `style`, …) untouched (spec
     * §4.1.5 — the deferred DOCX writer needs them later).
     * @param {string} tag
     * @param {string} mime
     * @param {string} base64
     * @returns {string}
     * @private
     */
    static _rewriteSrc(tag, mime, base64) {
        const match = tag.match(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/i);
        if (!match) return tag; // defensive — src was already confirmed present upstream
        const before = tag.slice(0, match.index);
        const after = tag.slice(match.index + match[0].length);
        return `${before}src="data:${mime};base64,${base64}"${after}`;
    }

    /** @returns {object} A fresh, zeroed stats object. @private */
    static _emptyStats() {
        return {
            totalFound: 0,
            embedded: 0,
            notBitmap: 0,
            failed: 0,
            budgetExceeded: false,
            totalBytes: 0,
            warnings: [],
        };
    }
}
