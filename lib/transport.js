/**
 * transport.js — Docs fetch transport tiers (spec §3.2 T1/T2, pulled forward
 * from P3 to fix a confirmed production bug in the `tabNav` path).
 *
 * THE BUG THIS FIXES: the legacy Docs pipeline blocks scripts on
 * docs.google.com via a DNR session rule, then navigates the user's tab to
 * `/mobilebasic`. In the real browser this now redirects to
 * `support.google.com/accounts/answer/32050` ("clear cache and cookies") —
 * Google decides the browser isn't handling cookies correctly, because
 * blocking scripts stops its own cookie/consent bootstrap. Extraction hangs
 * until the 20s content-script timeout, and the user's tab has been
 * navigated away from their document for nothing.
 *
 * Measured by hand in a real browser, on a genuinely restricted Doc, a
 * same-origin `fetch('/mobilebasic', {credentials:'include'})` from the
 * document's own tab returns HTTP 200 with the real document — no redirect,
 * no access wall. `/mobilebasic` itself is fine; only navigate-plus-
 * block-JS is broken. Fetching needs no DNR rule and no tab navigation.
 *
 * Two tiers, tried in order (first success wins — spec §3.2 "auto" chain
 * never auto-escalates past T2; T3 `tabNav` is an explicit, separate
 * fallback the caller decides to take):
 *
 *   T1 swFetch  fetch(url, {credentials:'include'}) from the service
 *               worker. Chrome treats extension→third-party requests as
 *               same-site when the extension holds host permissions, so
 *               even SameSite=Strict cookies are sent — except when
 *               third-party cookies are blocked (Incognito, or the user's
 *               own setting), which is exactly what T2 exists to cover.
 *   T2 csFetch  chrome.scripting.executeScript into the document's own
 *               open tab, running a SAME-ORIGIN fetch inside that page's
 *               own origin — first-party cookies, immune to third-party
 *               cookie blocking. This is the tier verified by hand above.
 *               Deliberately stays same-origin: fetches from an injected
 *               function are subject to the page's own CORS/CSP since
 *               Chrome 73, so this only ever requests the origin the tab
 *               is already on.
 *
 * `detectWall` is a pure function (no Chrome APIs) so it can be unit
 * tested directly under plain `node --test` — see test/transport.test.js.
 */

// ─── Wall detection (pure) ──────────────────────────────────────────────────

/**
 * A response body under this size is in the size range of Google's own
 * boilerplate sign-in / access-wall / help pages (a few KB), never a real
 * `/mobilebasic` export — that runs from tens of KB to several hundred KB
 * even for a short document, because of Google's CSS and markup overhead
 * (the restricted doc measured for this fix was 784,354 bytes). Gating the
 * body-text phrase match on size means a genuine document that happens to
 * use the words "request access" in its own prose (e.g. a policies doc) is
 * not misdetected as a wall — see test/transport.test.js and the T5 note
 * in the fix report.
 */
const SMALL_BODY_WALL_THRESHOLD = 20000;

/**
 * Detect whether a fetched response is actually a login/access wall rather
 * than the document itself. Pure function — no Chrome APIs, no I/O.
 *
 * Catches:
 *  - a redirect to Google's sign-in flow (`accounts.google.com`, `/ServiceLogin`)
 *  - a redirect to `support.google.com/accounts/answer/32050` — the exact
 *    "clear cache and cookies" page the broken tabNav path was redirecting
 *    to, and the regression this file fixes
 *  - a body whose `<title>` matches that same cookies-help page, for when
 *    a transport can't surface `finalUrl` (or Google changes the URL)
 *  - a small body containing "You need access" / "Request access" —
 *    Google's access-wall boilerplate, size-gated per the note above
 *
 * @param {string} html      Response body text (may be large).
 * @param {string} finalUrl  The URL the response actually landed on
 *                            (`response.url`), after any redirects.
 * @returns {string|null}    A short reason string, or null if not a wall.
 */
export function detectWall(html, finalUrl) {
    const url = typeof finalUrl === 'string' ? finalUrl : '';

    if (/accounts\.google\.com/i.test(url) || /\/ServiceLogin/i.test(url)) {
        return 'login_redirect';
    }

    // The exact production failure this file fixes (see file header).
    if (/support\.google\.com\/accounts\/answer\/32050/i.test(url)) {
        return 'cookies_help_redirect';
    }

    const body = typeof html === 'string' ? html : '';

    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : '';
    if (/clear\s+cache\b.{0,20}\bcookies/i.test(title)) {
        return 'cookies_help_title';
    }

    if (body.length > 0 && body.length < SMALL_BODY_WALL_THRESHOLD &&
        /You need access|Request access/i.test(body)) {
        return 'access_wall_body';
    }

    return null;
}

// ─── T1 — swFetch ────────────────────────────────────────────────────────

/**
 * T1: fetch the URL directly from the service worker.
 * @param {string} url
 * @returns {Promise<{ok: boolean, html: string, status: number, finalUrl: string}>}
 */
export async function swFetch(url) {
    try {
        const response = await fetch(url, { credentials: 'include' });
        const html = await response.text();
        return {
            ok: response.ok,
            html,
            status: response.status,
            finalUrl: response.url || url,
        };
    } catch (err) {
        console.warn('[Transport] swFetch network error:', err?.message || err);
        return { ok: false, html: '', status: 0, finalUrl: url };
    }
}

// ─── T2 — csFetch ────────────────────────────────────────────────────────

/**
 * T2: fetch the URL from inside the document's own tab, same-origin —
 * immune to third-party cookie blocking because it uses first-party
 * cookies (see file header). Must stay same-origin: the injected function
 * fetches exactly the URL/path it's given, nothing cross-origin.
 * @param {number} tabId
 * @param {string} path  Same-origin URL (or path) to fetch, inside the tab.
 * @returns {Promise<{ok: boolean, html: string, status: number, finalUrl: string}>}
 */
export async function csFetch(tabId, path) {
    let injectionResults;
    try {
        injectionResults = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (fetchPath) => {
                try {
                    const response = await fetch(fetchPath, { credentials: 'include' });
                    const text = await response.text();
                    return {
                        ok: response.ok,
                        html: text,
                        status: response.status,
                        finalUrl: response.url,
                    };
                } catch (err) {
                    return {
                        ok: false,
                        html: '',
                        status: 0,
                        finalUrl: '',
                        error: err?.message || String(err),
                    };
                }
            },
            args: [path],
        });
    } catch (err) {
        console.warn('[Transport] csFetch executeScript failed:', err?.message || err);
        return { ok: false, html: '', status: 0, finalUrl: path };
    }

    const result = injectionResults?.[0]?.result;
    if (!result) {
        console.warn('[Transport] csFetch: no injection result (tab may have navigated away).');
        return { ok: false, html: '', status: 0, finalUrl: path };
    }
    if (result.error) {
        console.warn('[Transport] csFetch in-page fetch error:', result.error);
    }

    return {
        ok: !!result.ok,
        html: result.html || '',
        status: result.status || 0,
        finalUrl: result.finalUrl || path,
    };
}

// ─── fetchDocHtml — tier orchestration ─────────────────────────────────────

/**
 * Fetch a document's HTML, trying T1 `swFetch` then T2 `csFetch` (spec
 * §3.2 "auto" chain — never auto-escalates to T3 `tabNav`; that is the
 * caller's explicit, separate last-resort fallback, see
 * `background/service-worker.js` `runFetchHtmlPipeline`/`runTabNavPipeline`).
 *
 * A non-2xx status, or a `detectWall` hit, means that tier failed and the
 * next tier is tried. If both fail, throws an error carrying the last wall
 * reason on `err.wallReason`.
 *
 * @param {{url: string, tabId: number}} opts
 * @returns {Promise<{html: string, transport: 'swFetch'|'csFetch'}>}
 */
export async function fetchDocHtml({ url, tabId }) {
    const failures = [];

    const sw = await swFetch(url);
    const swWall = detectWall(sw.html, sw.finalUrl);
    if (sw.ok && !swWall) {
        console.log('[Transport] swFetch succeeded.');
        return { html: sw.html, transport: 'swFetch' };
    }
    failures.push(swWall || `HTTP ${sw.status}`);
    console.warn(`[Transport] swFetch failed (${failures[failures.length - 1]}) — trying csFetch.`);

    if (tabId !== undefined && tabId !== null) {
        const cs = await csFetch(tabId, url);
        const csWall = detectWall(cs.html, cs.finalUrl);
        if (cs.ok && !csWall) {
            console.log('[Transport] csFetch succeeded.');
            return { html: cs.html, transport: 'csFetch' };
        }
        failures.push(csWall || `HTTP ${cs.status}`);
        console.warn(`[Transport] csFetch failed (${failures[failures.length - 1]}).`);
    } else {
        failures.push('no tabId available for csFetch');
    }

    const err = new Error(
        `Could not fetch the document through any transport tier — swFetch: ${failures[0]}` +
        (failures.length > 1 ? `; csFetch: ${failures[1]}` : '') + '.'
    );
    err.wallReason = failures[failures.length - 1];
    throw err;
}

// ─── Binary fetch — images (spec §4.1 T1/T2, added for v2.1) ──────────────
//
// `lib/image-embedder.js` needs the same T1→T2 tier ordering as
// `fetchDocHtml` above (a restricted document's image assets sit behind the
// exact same cookies as the document itself), but images are binary, not
// text, so this is a parallel set of helpers rather than a reuse of
// `swFetch`/`csFetch` directly:
//
//   T1 swFetchBinary  fetch(url, {credentials:'include'}) from the service
//                      worker, read as an ArrayBuffer.
//   T2 csFetchBinary  chrome.scripting.executeScript into the document's
//                      tab, same-origin fetch, base64-encoded INSIDE the
//                      page before returning — executeScript can only
//                      return structured-cloneable values, not a Blob or
//                      ArrayBuffer-with-transfer, so the page does the
//                      encoding itself and hands back a plain string.
//
// Wall detection is reused (not reimplemented) from `detectWall` above: a
// response whose content-type isn't `image/*` might genuinely be a non-
// bitmap resource (see image-embedder's own content-type guard), or it
// might be a login/access-wall page served instead of the asset. Only the
// latter should cause a fall-through to T2; the former is a legitimate
// answer the embedder needs to see as-is. A bounded prefix of the body is
// decoded to text and handed to `detectWall` to tell the two apart, so a
// multi-megabyte image body is never decoded as text just to classify it.

/** Per-tier network timeout for an image fetch (spec §4.2). */
const IMAGE_FETCH_TIMEOUT_MS = 8000;

/** How much decoded text (bytes) to sniff for a wall page (spec §4.1.3 note above). */
const WALL_SNIFF_BYTES = SMALL_BODY_WALL_THRESHOLD;

/**
 * @param {string|null|undefined} contentType
 * @returns {boolean} True if the content-type starts with `image/`.
 */
export function isImageContentType(contentType) {
    return /^image\//i.test(typeof contentType === 'string' ? contentType : '');
}

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
    let injectionResults;
    try {
        injectionResults = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (fetchPath, timeoutMs) => {
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
            args: [path, IMAGE_FETCH_TIMEOUT_MS],
        });
    } catch (err) {
        console.warn('[Transport] csFetchBinary executeScript failed:', err?.message || err);
        return { ok: false, base64: '', byteLength: 0, contentType: '', status: 0, finalUrl: path };
    }

    const result = injectionResults?.[0]?.result;
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
 * `lib/image-embedder.js` (see that file). Per-image size budgeting and the
 * `image/*` content-type guard are the embedder's job (spec §4.1.3/§4.2);
 * this function only fetches and classifies wall-vs-not.
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
