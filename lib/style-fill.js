/**
 * StyleFill — Pure logic for deciding what survives into an element's final
 * `style` attribute (spec v2.1 §3). Every function here takes and returns
 * plain strings/objects — no DOM, no `getComputedStyle` — so the decision
 * logic is unit-testable under plain `node --test` even though the CSS
 * cascade it is built to reason about only exists in a real browser.
 *
 * The offscreen parser (offscreen/parser.js) is the only caller. It reads
 * the DOM (authored `style` attribute text, `getComputedStyle` for the
 * element and its parent) and hands plain values in here; it must not
 * re-implement any of this decision logic inline (spec §6 file plan).
 *
 * ─── The rule (spec §3.1–§3.3), summarised ─────────────────────────────
 *
 *   1. BLOCKLIST, not whitelist: keep the entire authored `style` attribute
 *      verbatim except the small deny-list below (STYLE_DENY). A whitelist
 *      re-loses whatever Google adds next; a blocklist survives it.
 *
 *   2. Layout/geometry (`width`, `height`, `margin*`, `padding*`,
 *      `text-indent`) is AUTHORED ONLY. It is never filled from
 *      `getComputedStyle`, because the sandboxed iframe is not the user's
 *      page — a computed width is the iframe's used width, not the
 *      document's authored `30.6pt`. `buildElementStyle` enforces this
 *      simply by never consulting `computed`/`parentComputed` for anything
 *      outside `APPEARANCE_PROPERTIES`; there is no separate "layout" input.
 *
 *   3. Appearance/inherited properties (the explicit longhand list in
 *      `APPEARANCE_PROPERTIES`, §3.3) are authored if present; otherwise
 *      filled from the computed value, but only when it differs from the
 *      parent's computed value (so inherited values aren't restated on
 *      every node) and is not a meaningless CSS default
 *      (`isMeaninglessDefault`).
 *
 *   4. Never query a shorthand (`border`, `margin`, `padding`, `font`) via
 *      `getComputedStyle` — mobilebasic sets only longhands
 *      (`border-top-width`, `border-top-color`, ...), so a shorthand query
 *      silently returns `""` and the whole property is dropped (the F3
 *      defect this spec exists to fix). `APPEARANCE_PROPERTIES` lists
 *      longhands exclusively for this reason.
 */
export class StyleFill {

    /**
     * Deny-list (spec §3.1). Removed from the authored style regardless of
     * where it came from. `display` is denied because mobilebasic sets
     * `display:inline-block` on wrappers that reflow badly once the
     * surrounding chrome is gone; `max-width`/`min-width`/etc. are denied
     * because `.doc-content` carries a `770px` cap meant for the mobile
     * viewport, not the pasted document.
     */
    static STYLE_DENY = new Set([
        'position', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
        'z-index', 'transform', 'visibility', 'display', 'cursor',
        'user-select', '-webkit-user-select', 'pointer-events',
        'max-width', 'min-width', 'max-height', 'min-height',
    ]);

    /**
     * Layout/geometry properties (spec §3.2 table, row 1). AUTHORED ONLY —
     * never filled from computed style. Not consulted by `buildElementStyle`
     * directly (the authored style already carries them verbatim if
     * present); listed here so the rule is documented and testable in one
     * place rather than left implicit.
     */
    static LAYOUT_PROPERTIES = new Set([
        'width', 'height',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'text-indent',
    ]);

    /**
     * Appearance/inherited properties eligible for the computed-fill pass
     * (spec §3.3). Explicit longhands ONLY — see the F3 note in the module
     * doc comment above for why shorthands are never listed here.
     */
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
     * Parse a `style="..."` attribute string into a plain `{property: value}`
     * object. Property names are lower-cased; declarations with no colon or
     * an empty value are dropped. Splitting respects single/double-quoted
     * segments (e.g. `font-family:"Times New Roman"`) so a quoted value can
     * never be mistaken for a declaration boundary.
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
     * Split a style-attribute string on top-level `;` only — a `;` inside a
     * quoted string does not end the declaration.
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
     * Serialise a plain `{property: value}` object back into a
     * `style="..."` attribute string (without the surrounding quotes).
     * Empty/nullish values are skipped. Insertion order is preserved.
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

    // ─── Deny-list filter (spec §3.1) ──────────────────────────────────

    /**
     * Remove every `STYLE_DENY` property from a plain style object. Pure —
     * takes and returns plain objects, no DOM involved.
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

    // ─── Meaningless-default detection (spec §3.3, last paragraph) ─────

    /**
     * Decide whether a *computed* value for `property` is a CSS default
     * that carries no meaning and should never be emitted even when it
     * differs from the parent's computed value (e.g. the parent has no
     * border at all, so `border-top-width` differs from the parent's `0px`
     * only in the sense that the parent's value is `medium`/absent — both
     * are "no border").
     *
     * Only used for *computed* fills — an authored value is always kept
     * verbatim regardless of whether it happens to equal a CSS default,
     * because the author wrote it deliberately.
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

    // ─── Parent-diff decision (spec §3.2 row 2, §3.3 last paragraph) ───

    /**
     * Decide the value (if any) to emit for one appearance property, given
     * its own computed value and the parent's computed value. This is the
     * "diffed against the parent" rule: skip when it matches the parent
     * (inherited, not worth restating) or when it is a meaningless default.
     *
     * Callers only invoke this for a property that is NOT already present
     * in the authored style — authored always wins (see `buildElementStyle`).
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
     * Build the final style object for one element: authored style (minus
     * `STYLE_DENY`) plus a computed fill for any `APPEARANCE_PROPERTIES`
     * entry the author did not already set. Pure — `computed`/`parentComputed`
     * are plain `{property: value}` objects (as produced by reading
     * `getComputedStyle(...).getPropertyValue(...)` for each entry in
     * `APPEARANCE_PROPERTIES`, done by the caller), not live DOM objects.
     *
     * Layout/geometry properties are never added here beyond whatever the
     * authored style already contained — there is no computed source for
     * them by design (spec §3.2).
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
