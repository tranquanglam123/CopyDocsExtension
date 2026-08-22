/**
 * What survives into an element's final `style` attribute. Pure — the caller
 * reads the DOM and hands plain values in.
 *
 * The rules:
 *   1. Blocklist, not whitelist. A whitelist re-loses whatever Google adds next.
 *   2. Layout/geometry is authored only. A computed width is the sandbox
 *      iframe's used width, not the document's authored `30.6pt`.
 *   3. Appearance longhands fall back to the computed value, but only when it
 *      differs from the parent's and is not a meaningless default.
 *   4. Never query a shorthand: mobilebasic sets only longhands, so a
 *      shorthand read returns `""` and the property is lost.
 */
export class StyleFill {

    /**
     * `display:inline-block` wrappers reflow badly once the chrome is gone;
     * `.doc-content`'s `770px` cap is for the mobile viewport, not the paste.
     */
    static STYLE_DENY = new Set([
        'position', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
        'z-index', 'transform', 'visibility', 'display', 'cursor',
        'user-select', '-webkit-user-select', 'pointer-events',
        'max-width', 'min-width', 'max-height', 'min-height',
    ]);

    /** Authored only, never filled from computed style. Listed so the rule
     *  is testable in one place rather than left implicit. */
    static LAYOUT_PROPERTIES = new Set([
        'width', 'height',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'text-indent',
    ]);

    /** Eligible for the computed fill. Longhands only — see rule 4 above. */
    static APPEARANCE_PROPERTIES = [
        'color', 'background-color',
        'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
        'text-decoration-line', 'text-decoration-color', 'text-align', 'text-transform',
        'vertical-align', 'line-height', 'letter-spacing', 'white-space',
        'border-top-width', 'border-top-style', 'border-top-color',
        'border-right-width', 'border-right-style', 'border-right-color',
        'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
        'border-left-width', 'border-left-style', 'border-left-color',
        'list-style-type',
    ];

    // ─── Style-string <-> plain-object helpers ─────────────────────────

    /**
     * Property names are lower-cased; empty or colon-less declarations drop.
     * Quoted segments like `font-family:"Times New Roman"` split correctly.
     * @param {string} text
     * @returns {Object<string,string>}
     */
    static parseStyleString(text) {
        const result = {};
        if (!text || typeof text !== 'string') return result;

        for (const decl of StyleFill._splitDeclarations(text)) {
            const idx = decl.indexOf(':');
            if (idx === -1) continue;
            const prop = decl.slice(0, idx).trim().toLowerCase();
            const value = decl.slice(idx + 1).trim();
            if (!prop || !value) continue;
            result[prop] = value;
        }
        return result;
    }

    /**
     * Top-level `;` only — a `;` inside quotes does not end a declaration.
     * @param {string} text
     * @returns {string[]}
     */
    static _splitDeclarations(text) {
        const parts = [];
        let current = '';
        let quote = null;

        for (const ch of text) {
            if (quote) {
                current += ch;
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                current += ch;
                continue;
            }
            if (ch === ';') {
                parts.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.trim()) parts.push(current);
        return parts;
    }

    /**
     * Back to an attribute string, quotes excluded. Empty values are skipped,
     * insertion order preserved.
     * @param {Object<string,string>} styleObj
     * @returns {string}
     */
    static serializeStyle(styleObj) {
        if (!styleObj) return '';
        const parts = [];
        for (const [prop, value] of Object.entries(styleObj)) {
            if (value === undefined || value === null) continue;
            const v = String(value).trim();
            if (!v) continue;
            parts.push(`${prop}:${v}`);
        }
        return parts.join(';');
    }

    // ─── Deny-list filter ──────────────────────────────────────────────

    /**
     * @param {Object<string,string>} styleObj
     * @returns {Object<string,string>}
     */
    static filterDenied(styleObj) {
        const result = {};
        for (const [prop, value] of Object.entries(styleObj || {})) {
            if (StyleFill.STYLE_DENY.has(prop.toLowerCase())) continue;
            result[prop] = value;
        }
        return result;
    }

    // ─── Meaningless-default detection ─────────────────────────────────

    /**
     * A computed default worth nothing even when it differs from the parent:
     * `border-top-width:0px` against a parent's `medium` is still no border.
     *
     * Computed fills only — an authored value is kept verbatim, defaults
     * included, because the author wrote it deliberately.
     *
     * @param {string} property  Lower-case longhand property name.
     * @param {string} value     A resolved (computed) value.
     * @returns {boolean}
     */
    static isMeaninglessDefault(property, value) {
        if (value === undefined || value === null) return true;
        const v = String(value).trim().toLowerCase();
        if (!v) return true;
        const prop = String(property).trim().toLowerCase();

        if (prop === 'background-color' && StyleFill._isTransparentColor(v)) return true;
        if ((prop === 'text-decoration-line' || prop === 'text-decoration-color') && v === 'none') return true;
        if (prop === 'font-weight' && (v === 'normal' || v === '400')) return true;
        if (prop === 'font-style' && v === 'normal') return true;
        if (prop === 'font-variant' && v === 'normal') return true;
        // Covers every border-*-width longhand (and any other -width prop).
        if (prop.endsWith('-width') && StyleFill._isZeroLength(v)) return true;
        // A border-*-style of 'none' pairs with the 0-width case above —
        // either alone is enough to say "no border on this side".
        if (prop.endsWith('-style') && v === 'none') return true;

        return false;
    }

    /**
     * @param {string} v  Already trimmed + lower-cased.
     * @returns {boolean}
     */
    static _isTransparentColor(v) {
        return v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
    }

    /**
     * @param {string} v  Already trimmed + lower-cased.
     * @returns {boolean}
     */
    static _isZeroLength(v) {
        return /^0(px|pt|em|rem|%)?$/.test(v);
    }

    // ─── Parent-diff decision ──────────────────────────────────────────

    /**
     * Skip when the value matches the parent (inherited, not worth restating)
     * or is a meaningless default. Called only where the author set nothing.
     *
     * @param {{property: string, own: string|undefined|null, parent?: string|undefined|null}} args
     * @returns {string|null}  The value to emit, or `null` to emit nothing.
     */
    static resolveAppearanceValue({ property, own, parent } = {}) {
        if (own === undefined || own === null) return null;
        const ownValue = String(own).trim();
        if (!ownValue) return null;

        const parentValue = (parent === undefined || parent === null) ? '' : String(parent).trim();
        if (parentValue && ownValue.toLowerCase() === parentValue.toLowerCase()) return null;

        if (StyleFill.isMeaninglessDefault(property, ownValue)) return null;

        return ownValue;
    }

    // ─── Orchestration ──────────────────────────────────────────────────

    /**
     * Authored style minus `STYLE_DENY`, plus a computed fill for any
     * appearance longhand the author left unset. `computed`/`parentComputed`
     * are plain objects, not live DOM.
     *
     * @param {{authoredStyleText?: string, computed?: Object<string,string>, parentComputed?: Object<string,string>}} args
     * @returns {Object<string,string>}
     */
    static buildElementStyle({ authoredStyleText = '', computed = {}, parentComputed = {} } = {}) {
        const authored = StyleFill.filterDenied(StyleFill.parseStyleString(authoredStyleText));
        const result = { ...authored };

        for (const property of StyleFill.APPEARANCE_PROPERTIES) {
            if (Object.prototype.hasOwnProperty.call(result, property)) continue; // authored wins

            const resolved = StyleFill.resolveAppearanceValue({
                property,
                own: computed ? computed[property] : undefined,
                parent: parentComputed ? parentComputed[property] : undefined,
            });
            if (resolved !== null) result[property] = resolved;
        }

        return result;
    }
}
