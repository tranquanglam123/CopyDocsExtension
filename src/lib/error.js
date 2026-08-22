/**
 * An error carrying an i18n `code` and `params` instead of an English
 * sentence, so the popup can render it in the active language.
 *
 * `message` still holds a readable fallback for a console with no I18n.
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
