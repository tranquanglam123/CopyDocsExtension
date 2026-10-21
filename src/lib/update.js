/**
 * Self-update decisions, kept pure: what GitHub's latest release offers and
 * whether it is newer than the running copy.
 */

/**
 * @param {string} text  "2.1.0" or a tag such as "v2.1.0".
 * @returns {number[]|null} null for anything but dotted numbers.
 */
export function parseVersion(text) {
    const m = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(text ?? '').trim());
    return m ? m[1].split('.').map(Number) : null;
}

/**
 * Chrome's own rule for manifest versions: numeric parts, missing ones zero.
 * @returns {boolean} Whether `latest` is strictly newer than `current`.
 */
export function isNewer(latest, current) {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}

/**
 * GitHub's `releases/latest` answer, reduced to what an update needs.
 * @param {object|null} release
 * @param {string} assetName
 * @returns {{version: string}|null} null when nothing in it is installable.
 */
export function readRelease(release, assetName) {
    if (!release || release.draft || release.prerelease) return null;
    const version = parseVersion(release.tag_name);
    const hasAsset = (release.assets || []).some((a) => a?.name === assetName);
    return version && hasAsset ? { version: version.join('.') } : null;
}

/**
 * A stored check is redone when missing, too old, or made by another
 * version — after an update it describes the copy that was replaced.
 * @param {{current?: string, checkedAt?: number}|null} info
 * @param {string} currentVersion
 * @param {number} now
 * @param {number} maxAgeMs
 */
export function needsCheck(info, currentVersion, now, maxAgeMs) {
    if (!info || info.current !== currentVersion) return true;
    return !(now - info.checkedAt < maxAgeMs);
}
