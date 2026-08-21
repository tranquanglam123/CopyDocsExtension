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
