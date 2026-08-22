/**
 * Docs HTML fetch tiers. Measured by hand on a restricted Doc: a same-origin
 * `fetch('/mobilebasic', {credentials:'include'})` returns 200 with the real
 * document. Only navigate-plus-block-JS is broken, and it needs no DNR rule.
 *
 * Two tiers, first success wins; tabnav is the caller's separate last resort:
 *
 *   T1 swFetch  fetch from the service worker. Host permissions make Chrome
 *               treat it as same-site, so even SameSite=Strict cookies go —
 *               unless third-party cookies are blocked, which is T2's job.
 *   T2 csFetch  same-origin fetch injected into the tab: first-party cookies,
 *               immune to that blocking. Stays same-origin because an
 *               injected fetch obeys the page's own CORS/CSP.
 */
import { detectWall } from '../../lib/wall.js';
import { executeInTab } from '../../bridge/chrome/scripting.js';

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
 * T2: same-origin fetch inside the document's own tab. The injected function
 * fetches exactly the path it is given, nothing cross-origin.
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
 * T1 then T2, never escalating to tabnav — that is the caller's decision.
 * A non-2xx or a `detectWall` hit fails the tier. Both failing throws, with
 * the last wall reason on `err.wallReason`.
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
