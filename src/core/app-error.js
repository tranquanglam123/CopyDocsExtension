/**
 * app-error.js — a thrown error that carries an i18n key instead of a
 * hardcoded English sentence (spec v3 §5.3).
 *
 * The pipelines used to `throw new Error('This spreadsheet requires
 * sign-in — …')` and the popup displayed that string verbatim — untranslatable
 * by construction, because the sentence itself was the only copy of the
 * message. AppError carries a `code` (an i18n message key, e.g.
 * `'error.sheetSignInRequired'`) and `params` for interpolation instead; the
 * popup calls `I18n.t(err.code, err.params)` to render it in whichever
 * language is active.
 *
 * `message` still gets a readable fallback (the code plus its params) so an
 * AppError prints sensibly to the console, or displays sensibly, even in a
 * context that has no access to I18n (e.g. a background console.error).
 * Degrade, never blank (spec v3 §5.3) — this mirrors the same rule
 * `shared/i18n.js` applies to a missing translation key.
 *
 * Pure — no imports, no chrome.*, no DOM — so it can be thrown from
 * src/extraction/ (chrome-free, spec v3 §2) and caught anywhere.
 */
export class AppError extends Error {
    /**
     * @param {string} code       An i18n message key (e.g. 'error.sheetAccessWall').
     * @param {object} [params]   Values to interpolate into the translated string.
     */
    constructor(code, params = {}) {
        super(AppError._fallbackMessage(code, params));
        this.name = 'AppError';
        this.code = code;
        this.params = params;
    }

    /**
     * @param {string} code
     * @param {object} params
     * @returns {string}
     * @private
     */
    static _fallbackMessage(code, params) {
        const keys = Object.keys(params);
        if (keys.length === 0) return code;
        return `${code} (${keys.map((k) => `${k}=${params[k]}`).join(', ')})`;
    }
}
