/**
 * http-transport.js — Docs fetch transport tiers (spec §3.2 T1/T2, pulled
 * forward from P3 to fix a confirmed production bug in the `tabNav` path).
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
 *   T2 csFetch  script injection (via platform/scripting.js —
 *               src/extraction/ itself stays free of Chrome APIs, spec v3
 *               §2) into the document's own open tab, running a SAME-ORIGIN
 *               fetch inside that page's own origin — first-party
 *               cookies, immune to third-party cookie blocking. This is
 *               the tier verified by hand above. Deliberately stays
 *               same-origin: fetches from an injected function are
 *               subject to the page's own CORS/CSP since Chrome 73, so
 *               this only ever requests the origin the tab is already on.
 *
 * Wall detection (`detectWall`) lives in core/wall-detector.js (spec v3
 * §2 — pure logic belongs in core/, and is unit tested directly under
 * plain `node --test` — see test/transport.test.js). Binary/image
 * transport tiers live in extraction/binary-transport.js.
 */
import { detectWall } from '../core/wall-detector.js';
import { executeInTab } from '../platform/scripting.js';

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
    let result;
    try {
        result = await executeInTab(
            tabId,
            async (fetchPath) => {
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
            [path]
        );
    } catch (err) {
        console.warn('[Transport] csFetch executeScript failed:', err?.message || err);
        return { ok: false, html: '', status: 0, finalUrl: path };
    }

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
 * `extraction/pipeline-runner.js`'s `dispatchTransport` and
 * `extraction/tabnav-pipeline.js`'s `runTabNavPipeline`).
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
