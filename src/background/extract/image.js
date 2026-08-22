/**
 * `docs.google.com` images sit behind the user's cookies and do not survive
 * a paste, so inline them as `data:` URIs. Failure keeps the original src.
 */

import { IMAGE_LIMITS, WARNINGS, WARNING_PREFIXES } from '../../lib/const.js';
import { fetchBinary } from './binary.js';
import { isImageContentType } from '../../lib/wall.js';
import { isEmbedImagesEnabled } from '../../bridge/chrome/storage.js';

export class ImageEmbedder {

    /** Per-image decoded-size cap. */
    static PER_IMAGE_MAX_BYTES = IMAGE_LIMITS.PER_IMAGE_MAX_BYTES;

    /** Decoded-size budget across all images in one document. */
    static TOTAL_BUDGET_BYTES = IMAGE_LIMITS.TOTAL_BUDGET_BYTES;

    /** Max simultaneous in-flight image fetches. */
    static MAX_CONCURRENT = IMAGE_LIMITS.MAX_CONCURRENT;

    /** Also applied inside the transports, so an injected fetchFn that
     *  forgets to time out cannot stall the pass. */
    static TIMEOUT_MS = IMAGE_LIMITS.TIMEOUT_MS;

    // ─── Entry point ────────────────────────────────────────────────────

    /**
     * Rewrite every `docs.google.com` `<img src>` to a `data:` URI. Never throws.
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
     *   `fetchFn` defaults to `fetchBinary`; overridable so tests run the
     *   collection/guard/budget logic without any Chrome API.
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

        if (stats.failed > 0) stats.warnings.push(`${WARNING_PREFIXES.IMAGE_EMBED_FAILED}:${stats.failed}`);
        if (stats.notBitmap > 0) stats.warnings.push(`${WARNING_PREFIXES.IMAGE_NOT_BITMAP}:${stats.notBitmap}`);
        if (stats.budgetExceeded) stats.warnings.push(WARNINGS.IMAGE_BUDGET_EXCEEDED);

        console.log(
            `[extract/image] ${stats.embedded}/${stats.totalFound} embedded ` +
            `(not-bitmap: ${stats.notBitmap}, failed: ${stats.failed}, ` +
            `budgetExceeded: ${stats.budgetExceeded}), ${stats.totalBytes} bytes total.`
        );

        return { bodyHtml: newBodyHtml, stats };
    }

    // ─── Collection (pure) ──────────────────────────────────────────────

    /**
     * Every `<img src="…">` whose host is exactly `docs.google.com`.
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
     * Outcome per image: embed | not-bitmap | budget | budget-skip | fail.
     * Past a budget, images not yet started are never fetched.
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
                console.warn(`[extract/image] fetch threw for ${image.src}:`, err?.message || err);
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
     * Rebuild `bodyHtml`, rewriting only 'embed' outcomes. Other tags stay
     * byte-for-byte.
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
     * Replace only `src="…"`; `width`, `height`, `style` stay untouched.
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

// ─── Wire into a full extraction result ───────────────────────────────────

/**
 * For the two Docs pipelines; via-csv.js has no `<img>` tags. Honours the
 * popup's embed toggle, default ON.
 *
 * @param {object} result   The parse-result contract ({title, text, html, bodyHtml, charCount, meta}).
 * @param {number|undefined} tabId  The document's own tab — needed for the T2 csFetch fallback.
 * @returns {Promise<object>} A new result object; `result` is not mutated.
 */
export async function embedImagesIntoResult(result, tabId) {
    if (!result || typeof result.bodyHtml !== 'string' || result.bodyHtml.length === 0) {
        return result;
    }

    const enabled = await isEmbedImagesEnabled();
    if (!enabled) {
        console.log('[extract/image] Image embedding is OFF (popup toggle) — leaving image URLs as-is.');
        return result;
    }

    const oldBodyHtml = result.bodyHtml;
    let embedResult;
    try {
        embedResult = await ImageEmbedder.embedImages(oldBodyHtml, {
            tabId,
            budgetBytes: ImageEmbedder.TOTAL_BUDGET_BYTES,
        });
    } catch (err) {
        // Defense in depth only — embedImages is designed to never throw.
        console.error('[extract/image] embedImages threw unexpectedly (non-fatal, keeping original bodyHtml):', err);
        return result;
    }

    const { bodyHtml: newBodyHtml, stats } = embedResult;

    // The clipboard's text/html flavour is `result.html`, so it needs the
    // same embedded images.
    const newHtml = _spliceBodyHtml(result.html, oldBodyHtml, newBodyHtml);

    return {
        ...result,
        bodyHtml: newBodyHtml,
        html: newHtml,
        meta: {
            ...(result.meta || {}),
            warnings: [...(result.meta?.warnings || []), ...stats.warnings],
            imageStats: stats,
        },
    };
}

/**
 * indexOf + slice, not `String.replace`: `replace` treats `$&`/`$1`/`$$` in
 * the replacement specially, and document content can contain a literal `$1`.
 *
 * @param {string} fullHtml
 * @param {string} oldBodyHtml
 * @param {string} newBodyHtml
 * @returns {string}
 */
function _spliceBodyHtml(fullHtml, oldBodyHtml, newBodyHtml) {
    if (typeof fullHtml !== 'string' || !oldBodyHtml) return fullHtml;
    const idx = fullHtml.indexOf(oldBodyHtml);
    if (idx === -1) {
        console.warn(
            '[extract/image] Could not locate bodyHtml inside the full wrapped document — ' +
            'html left without embedded images (bodyHtml/clipboard text still has them).'
        );
        return fullHtml;
    }
    return fullHtml.slice(0, idx) + newBodyHtml + fullHtml.slice(idx + oldBodyHtml.length);
}
