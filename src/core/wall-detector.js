/**
 * wall-detector.js — pure wall/login-wall detection (spec v3 §3.3 T2),
 * split out of extraction/http-transport.js so it has no Chrome-API / fetch
 * dependency and can sit in core/ (spec v3 §2). See http-transport.js's
 * file header for why the T1/T2 fetch-transport tiers exist at all; this
 * file only classifies a response body/URL as a wall or not.
 *
 * `detectWall` and `isImageContentType` are pure functions — no Chrome
 * APIs, no I/O — so they are unit tested directly under plain
 * `node --test` (see test/transport.test.js).
 */

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
export const SMALL_BODY_WALL_THRESHOLD = 20000;

/**
 * Detect whether a fetched response is actually a login/access wall rather
 * than the document itself. Pure function — no Chrome APIs, no I/O.
 *
 * Catches:
 *  - a redirect to Google's sign-in flow (`accounts.google.com`, `/ServiceLogin`)
 *  - a redirect to `support.google.com/accounts/answer/32050` — the exact
 *    "clear cache and cookies" page the broken tabNav path was redirecting
 *    to, and the regression http-transport.js's T1/T2 tiers exist to fix
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

    // The exact production failure http-transport.js's tiers exist to fix.
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

/**
 * @param {string|null|undefined} contentType
 * @returns {boolean} True if the content-type starts with `image/`.
 */
export function isImageContentType(contentType) {
    return /^image\//i.test(typeof contentType === 'string' ? contentType : '');
}
