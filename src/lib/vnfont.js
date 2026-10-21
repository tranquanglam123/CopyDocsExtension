/**
 * Pre-Unicode Vietnamese fonts. VNI and TCVN3 (ABC) map Vietnamese letters
 * onto Latin-1 code points, so their text reads as garbage once extracted.
 */

const LEGACY = /(^|[+\s])(VNI[-_ ]|\.?Vn[A-Z]|VN-?Times)/;

/**
 * @param {string|null|undefined} fontName  e.g. `SLIIDO+VNI-Times`, `.VnTime`.
 * @returns {boolean}
 */
export function isLegacyVnFont(fontName) {
    return typeof fontName === 'string' && LEGACY.test(fontName);
}
