/**
 * A resolved style to the semantic tag that represents it.
 *
 * Callers must pass `getComputedStyle` values, never `node.style`:
 * mobilebasic carries bold/italic/underline as classes, so inline style
 * alone drops almost all character formatting.
 */
export class StyleDecision {

    /** font-weight keywords/thresholds that count as "bold". */
    static BOLD_KEYWORDS = new Set(['bold', 'bolder']);

    /** Numeric font-weight at or above this value is treated as bold. */
    static BOLD_WEIGHT_THRESHOLD = 600;

    /** font-style values that count as "italic". */
    static ITALIC_VALUES = new Set(['italic', 'oblique']);

    /**
     * Decide whether a resolved font-weight counts as bold.
     * @param {string|number|undefined|null} fontWeight  e.g. '700', 700, 'bold', 'normal'
     * @returns {boolean}
     */
    static isBold(fontWeight) {
        if (fontWeight === undefined || fontWeight === null) return false;
        const raw = String(fontWeight).trim().toLowerCase();
        if (!raw) return false;
        if (StyleDecision.BOLD_KEYWORDS.has(raw)) return true;

        const numeric = Number(raw);
        if (!Number.isNaN(numeric)) {
            return numeric >= StyleDecision.BOLD_WEIGHT_THRESHOLD;
        }
        return false;
    }

    /**
     * Decide whether a resolved font-style counts as italic.
     * @param {string|undefined|null} fontStyle  e.g. 'italic', 'oblique', 'normal'
     * @returns {boolean}
     */
    static isItalic(fontStyle) {
        if (!fontStyle) return false;
        const raw = String(fontStyle).trim().toLowerCase();
        // 'oblique 14deg' is valid CSS, so match the leading keyword.
        const keyword = raw.split(/\s+/)[0];
        return StyleDecision.ITALIC_VALUES.has(keyword);
    }

    /**
     * Decide whether a resolved text-decoration-line counts as underline.
     * @param {string|undefined|null} textDecorationLine  e.g. 'underline', 'underline line-through', 'none'
     * @returns {boolean}
     */
    static isUnderline(textDecorationLine) {
        if (!textDecorationLine) return false;
        return String(textDecorationLine).toLowerCase().includes('underline');
    }

    /**
     * All three flags at once, for a caller preserving combined formatting
     * rather than collapsing to one tag.
     * @param {{fontWeight?: string|number, fontStyle?: string, textDecorationLine?: string, textDecoration?: string}} style
     * @returns {{bold: boolean, italic: boolean, underline: boolean}}
     */
    static styleFlags({ fontWeight, fontStyle, textDecorationLine, textDecoration } = {}) {
        return {
            bold: StyleDecision.isBold(fontWeight),
            italic: StyleDecision.isItalic(fontStyle),
            // Some engines expose only the `textDecoration` shorthand.
            underline: StyleDecision.isUnderline(textDecorationLine ?? textDecoration),
        };
    }

    /**
     * One tag only. Priority when several flags are true: bold, italic,
     * underline.
     * @param {{fontWeight?: string|number, fontStyle?: string, textDecorationLine?: string, textDecoration?: string}} style
     * @returns {'b'|'i'|'u'|null}
     */
    static styleToTag(style = {}) {
        const { bold, italic, underline } = StyleDecision.styleFlags(style);
        if (bold) return 'b';
        if (italic) return 'i';
        if (underline) return 'u';
        return null;
    }
}
