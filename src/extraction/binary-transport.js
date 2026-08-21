/**
 * binary-transport.js — Binary (image) fetch transport tiers (spec §4.1
 * T1/T2, added for v2.1). Split out of http-transport.js (spec v3 §2) —
 * same T1 swFetch → T2 csFetch ordering as the HTML transport, but images
 * are binary, not text, so this is a parallel set of helpers rather than a
 * reuse of `swFetch`/`csFetch` directly:
 *
 *   T1 swFetchBinary  fetch(url, {credentials:'include'}) from the service
 *                      worker, read as an ArrayBuffer.
 *   T2 csFetchBinary  script injection (via platform/scripting.js —
 *                      src/extraction/ itself stays free of Chrome APIs)
 *                      into the document's tab,
 *                      same-origin fetch, base64-encoded INSIDE the page
 *                      before returning — executeScript can only return
 *                      structured-cloneable values, not a Blob or
 *                      ArrayBuffer-with-transfer, so the page does the
 *                      encoding itself and hands back a plain string.
 *
 * Wall detection is reused (not reimplemented) from core/wall-detector.js's
 * `detectWall`: a response whose content-type isn't `image/*` might
 * genuinely be a non-bitmap resource (see image-embedder's own
 * content-type guard), or it might be a login/access-wall page served
 * instead of the asset. Only the latter should cause a fall-through to T2;
 * the former is a legitimate answer the embedder needs to see as-is. A
 * bounded prefix of the body is decoded to text and handed to `detectWall`
 * to tell the two apart, so a multi-megabyte image body is never decoded
 * as text just to classify it.
 */
import { IMAGE_LIMITS } from '../shared/constants.js';
import { detectWall, isImageContentType, SMALL_BODY_WALL_THRESHOLD } from '../core/wall-detector.js';
import { executeInTab } from '../platform/scripting.js';

/** Per-tier network timeout for an image fetch (spec §4.2). */
const IMAGE_FETCH_TIMEOUT_MS = IMAGE_LIMITS.TIMEOUT_MS;

/** How much decoded text (bytes) to sniff for a wall page (spec §4.1.3 note above). */
const WALL_SNIFF_BYTES = SMALL_BODY_WALL_THRESHOLD;

/**
 * Base64-encode an ArrayBuffer without spreading it through
 * `String.fromCharCode(...bytes)` in one call, which blows the call stack
 * on multi-megabyte images.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Decode a bounded prefix of a base64 payload back to text, purely to feed
 * `detectWall`. Never decodes the whole thing — a wall page is a few KB;
 * anything genuinely larger than that is not a wall page regardless of
 * what the rest of it contains.
 * @param {string} base64
 * @returns {string}
 */
function decodeBase64TextPrefix(base64) {
    if (!base64) return '';
    // ~4 base64 chars encode 3 bytes; round down to a multiple of 4 so atob
    // never trips over truncated padding.
    let sliceLen = Math.ceil((WALL_SNIFF_BYTES * 4) / 3);
    sliceLen -= sliceLen % 4;
    try {
        return atob(base64.slice(0, sliceLen));
    } catch {
        return '';
    }
}

/**
 * Race a promise against a timeout, resolving (never rejecting) to a
 * failure shape on timeout so callers don't need a try/catch just for this.
 * @param {Promise<object>} promise
 * @param {number} ms
 * @returns {Promise<object>}
 */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, status: 0, timedOut: true }), ms);
    });
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
}

/**
 * T1: fetch an image URL directly from the service worker.
 * @param {string} url
 * @returns {Promise<{ok: boolean, base64: string, byteLength: number, contentType: string, status: number, finalUrl: string}>}
 */
export async function swFetchBinary(url) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal });
        const contentType = response.headers.get('content-type') || '';
        const buffer = await response.arrayBuffer();
        return {
            ok: response.ok,
            base64: arrayBufferToBase64(buffer),
            byteLength: buffer.byteLength,
            contentType,
            status: response.status,
            finalUrl: response.url || url,
        };
    } catch (err) {
        console.warn('[Transport] swFetchBinary failed:', err?.message || err);
        return { ok: false, base64: '', byteLength: 0, contentType: '', status: 0, finalUrl: url };
    } finally {
        clearTimeout(abortTimer);
    }
}

/**
 * T2: fetch an image URL from inside the document's own tab, same-origin,
 * converting to base64 INSIDE the page (see file-header note — executeScript
 * cannot return a Blob).
 * @param {number} tabId
 * @param {string} path  Same-origin URL to fetch, inside the tab.
 * @returns {Promise<{ok: boolean, base64: string, byteLength: number, contentType: string, status: number, finalUrl: string}>}
 */
export async function csFetchBinary(tabId, path) {
    let result;
    try {
        result = await executeInTab(
            tabId,
            async (fetchPath, timeoutMs) => {
                const controller = new AbortController();
                const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const response = await fetch(fetchPath, { credentials: 'include', signal: controller.signal });
                    const contentType = response.headers.get('content-type') || '';
                    const buffer = await response.arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    const CHUNK = 0x8000;
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += CHUNK) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                    }
                    return {
                        ok: response.ok,
                        base64: btoa(binary),
                        byteLength: bytes.length,
                        contentType,
                        status: response.status,
                        finalUrl: response.url,
                    };
                } catch (err) {
                    return {
                        ok: false, base64: '', byteLength: 0, contentType: '', status: 0, finalUrl: '',
                        error: err?.message || String(err),
                    };
                } finally {
                    clearTimeout(abortTimer);
                }
            },
            [path, IMAGE_FETCH_TIMEOUT_MS]
        );
    } catch (err) {
        console.warn('[Transport] csFetchBinary executeScript failed:', err?.message || err);
        return { ok: false, base64: '', byteLength: 0, contentType: '', status: 0, finalUrl: path };
    }

    if (!result) {
        console.warn('[Transport] csFetchBinary: no injection result (tab may have navigated away).');
        return { ok: false, base64: '', byteLength: 0, contentType: '', status: 0, finalUrl: path };
    }
    if (result.error) {
        console.warn('[Transport] csFetchBinary in-page fetch error:', result.error);
    }

    return {
        ok: !!result.ok,
        base64: result.base64 || '',
        byteLength: result.byteLength || 0,
        contentType: result.contentType || '',
        status: result.status || 0,
        finalUrl: result.finalUrl || path,
    };
}

/**
 * Fetch a binary image resource, trying T1 `swFetchBinary` then T2
 * `csFetchBinary` — same ordering and first-success-wins rule as
 * `fetchDocHtml`, deliberately NOT reimplemented inside
 * `extraction/image-embedder.js` (see that file). Per-image size budgeting
 * and the `image/*` content-type guard are the embedder's job (spec
 * §4.1.3/§4.2); this function only fetches and classifies wall-vs-not.
 *
 * A non-2xx status, network error, or timeout counts as that tier failing.
 * A 2xx response with a non-`image/*` content-type is NOT automatically a
 * failure — it might be a genuine non-bitmap resource (spec §8 Q2) — unless
 * `detectWall` recognizes it as a login/access wall, in which case the next
 * tier is tried (the wall is a cookie/session problem T2's same-origin
 * fetch may not share).
 *
 * @param {{url: string, tabId?: number}} opts
 * @returns {Promise<{ok: boolean, base64: string, byteLength: number, contentType: string, status: number, finalUrl: string, transport: 'swFetch'|'csFetch', wallReason?: string}>}
 */
export async function fetchBinary({ url, tabId }) {
    const failures = [];

    const sw = await withTimeout(swFetchBinary(url), IMAGE_FETCH_TIMEOUT_MS + 500);
    const swWall = sw.ok && !isImageContentType(sw.contentType)
        ? detectWall(decodeBase64TextPrefix(sw.base64), sw.finalUrl)
        : null;
    if (sw.ok && !swWall) {
        // Breadcrumb for spec §8 Q3 ("which transport tier serves images")
        // — see test/MANUAL-CHECKLIST.md Path D3.
        console.log(`[Transport] swFetchBinary succeeded for ${url} (${sw.contentType || 'no content-type'}).`);
        return { ...sw, transport: 'swFetch' };
    }
    failures.push(swWall || `HTTP ${sw.status}`);
    console.warn(`[Transport] swFetchBinary failed (${failures[failures.length - 1]}) for ${url} — trying csFetchBinary.`);

    if (tabId !== undefined && tabId !== null) {
        const cs = await withTimeout(csFetchBinary(tabId, url), IMAGE_FETCH_TIMEOUT_MS + 500);
        const csWall = cs.ok && !isImageContentType(cs.contentType)
            ? detectWall(decodeBase64TextPrefix(cs.base64), cs.finalUrl)
            : null;
        if (cs.ok && !csWall) {
            console.log(`[Transport] csFetchBinary succeeded for ${url} (${cs.contentType || 'no content-type'}).`);
            return { ...cs, transport: 'csFetch' };
        }
        failures.push(csWall || `HTTP ${cs.status}`);
        console.warn(`[Transport] csFetchBinary failed (${failures[failures.length - 1]}) for ${url}.`);

        return {
            ok: false, base64: '', byteLength: 0, contentType: '', status: cs.status,
            finalUrl: cs.finalUrl, transport: 'csFetch', wallReason: failures[failures.length - 1],
        };
    }

    return {
        ok: false, base64: '', byteLength: 0, contentType: '', status: sw.status,
        finalUrl: sw.finalUrl, transport: 'swFetch', wallReason: failures[failures.length - 1],
    };
}
