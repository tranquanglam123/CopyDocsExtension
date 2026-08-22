/**
 * Image fetch tiers, same swFetch → csFetch order as http.js. Images are
 * binary, so these are parallel helpers, not a reuse of the text ones:
 *
 *   T1 swFetchBinary  fetch from the service worker, read as ArrayBuffer.
 *   T2 csFetchBinary  same-origin fetch inside the tab, base64-encoded in
 *                     the page — executeScript returns only cloneable values.
 *
 * A non-`image/*` content-type may be a genuine non-bitmap resource or a
 * login wall served in its place. Only a wall falls through to T2, so a
 * bounded prefix is decoded and handed to `detectWall` to tell them apart.
 */
import { IMAGE_LIMITS } from '../../lib/const.js';
import { detectWall, isImageContentType, SMALL_BODY_WALL_THRESHOLD } from '../../lib/wall.js';
import { executeInTab } from '../../bridge/chrome/scripting.js';

/** Per-tier network timeout for an image fetch. */
const IMAGE_FETCH_TIMEOUT_MS = IMAGE_LIMITS.TIMEOUT_MS;

/** How much decoded text to sniff for a wall page. */
const WALL_SNIFF_BYTES = SMALL_BODY_WALL_THRESHOLD;

/**
 * Chunked: `String.fromCharCode(...bytes)` in one call blows the stack on a
 * multi-megabyte image.
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
 * A bounded prefix only, to feed `detectWall`. A wall page is a few KB;
 * anything larger is not one.
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
 * Resolves, never rejects, so callers need no try/catch for a timeout.
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
 * T2: same-origin fetch inside the tab, base64-encoded in the page because
 * executeScript cannot return a Blob.
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
 * T1 then T2, first success wins. Size budgeting and the `image/*` guard
 * belong to image.js; this only fetches and classifies wall-vs-not.
 *
 * Non-2xx, network error or timeout fails that tier. A 2xx with a
 * non-`image/*` type falls through only when `detectWall` calls it a wall —
 * a cookie problem T2's same-origin fetch may not share.
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
        // Breadcrumb for which tier actually serves images.
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
