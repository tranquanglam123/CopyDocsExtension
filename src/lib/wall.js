/** Classify a response body and URL as a login/access wall, or not. */

/**
 * Google's boilerplate wall pages are a few KB; a real `/mobilebasic` export
 * is tens to hundreds (the doc measured here was 784,354 bytes). Gating the
 * phrase match on size stops a policies doc saying "request access" in its
 * own prose from being flagged.
 */
export const SMALL_BODY_WALL_THRESHOLD = 20000;

/**
 * Catches a redirect to the sign-in flow; a redirect to the "clear cache and
 * cookies" page tabnav trips; a body whose `<title>` is that page, for a
 * transport with no `finalUrl`; and a small body saying "You need access" or
 * "Request access".
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

    // The exact failure the fetch tiers exist to avoid.
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
