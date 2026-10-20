/**
 * Optional host permissions. A file embedded from another site can only be
 * fetched with its host granted; the request must come from a user click.
 */

/**
 * @param {string[]} origins  Host patterns, e.g. `https://cdn.example.com/*`.
 * @returns {Promise<boolean>} Whether every origin is granted afterwards.
 */
export async function ensureOrigins(origins) {
    if (!origins || origins.length === 0) return true;
    // No contains() first: awaiting it can spend the click's user gesture,
    // and request() resolves true without a prompt when already granted.
    return chrome.permissions.request({ origins });
}
