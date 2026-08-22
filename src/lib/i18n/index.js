/**
 * i18n.js — runtime English/Vietnamese switching (spec v3 §5).
 *
 * Chrome's native `_locales` mechanism resolves the locale from the browser
 * UI language and cannot be switched at runtime (spec v3 §5.1), so this is a
 * from-scratch implementation instead — one mechanism only, no `_locales`.
 *
 * Dictionaries are ES modules (`shared/locales/en.js`, `vi.js`), not JSON:
 * no fetch, no `web_accessible_resources`, and they load identically in the
 * popup and the service worker.
 *
 * This file lives under src/shared/, the bottom of the dependency graph: it
 * may not import from any layer above it and may not touch `chrome.*`. The
 * locale dictionaries are siblings inside shared/, so importing them is fine.
 *
 * Persisting the chosen language and detecting the browser's UI language both
 * need `chrome.storage`/`chrome.i18n`, which this file may not call. That
 * logic lives in `src/platform/language.js` and is *injected* into
 * `I18n.init()` by the popup bootstrap — `I18n` itself never knows chrome
 * exists, which is also what makes it testable under `node --test`.
 */

import { dict as EN } from './en.js';
import { dict as VI } from './vi.js';

const SUPPORTED_LANGUAGES = ['en', 'vi'];
const DEFAULT_LANGUAGE = 'en';

/** @type {'en'|'vi'} */
let currentLanguage = DEFAULT_LANGUAGE;
/** @type {Record<string,string>|null} */
let currentDict = null;
/** Remembered from init() so a later setLanguage() call still persists. @type {((lang:string)=>Promise<void>)|null} */
let persistFn = null;

/** Both dictionaries are a few KB — loading both costs less than lazy plumbing. */
const DICTIONARIES = { en: EN, vi: VI };

/**
 * @param {string} lang
 * @returns {Promise<Record<string,string>>}
 */
async function loadDictionary(lang) {
    return DICTIONARIES[lang] || DICTIONARIES[DEFAULT_LANGUAGE];
}

/**
 * @param {string} template
 * @param {object} [params]
 * @returns {string}
 */
function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
    );
}

/**
 * @param {string} lang
 * @param {{persist: boolean}} opts
 * @returns {Promise<void>}
 */
async function applyLanguage(lang, { persist }) {
    currentDict = await loadDictionary(lang);
    currentLanguage = lang;
    if (persist && persistFn) {
        try {
            await persistFn(lang);
        } catch (err) {
            console.warn('[i18n] Could not persist language choice:', err);
        }
    }
}

export const I18n = {
    /**
     * Load the persisted language, else detect one, else fall back to
     * English. Both dependencies are optional and chrome-free by design —
     * see the file header — so this also works with no arguments at all
     * (used directly by tests that only exercise `t()`/`apply()`).
     *
     * @param {{
     *   getStoredLanguage?: () => Promise<string|null>,
     *   detectLanguage?: () => string,
     *   setStoredLanguage?: (lang: string) => Promise<void>,
     * }} [deps]
     * @returns {Promise<void>}
     */
    async init(deps = {}) {
        const { getStoredLanguage, detectLanguage, setStoredLanguage } = deps;
        persistFn = typeof setStoredLanguage === 'function' ? setStoredLanguage : null;

        let lang = null;
        if (typeof getStoredLanguage === 'function') {
            try {
                lang = await getStoredLanguage();
            } catch (err) {
                console.warn('[i18n] Could not read the persisted language:', err);
            }
        }
        if (!lang && typeof detectLanguage === 'function') {
            try {
                lang = detectLanguage();
            } catch (err) {
                console.warn('[i18n] Language detection failed:', err);
            }
        }

        // The value just loaded is already what's persisted (or there was
        // nothing to persist yet) — no need to write it straight back out.
        await applyLanguage(SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE, { persist: false });
    },

    /**
     * Switch language and persist the choice (via the setter `init()` was
     * given, if any). Callers re-render after this resolves — I18n itself
     * has no DOM to re-render other than what `apply()` is given.
     * @param {string} lang
     * @returns {Promise<void>}
     */
    async setLanguage(lang) {
        await applyLanguage(SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE, { persist: true });
    },

    /** @returns {'en'|'vi'} */
    getLanguage() {
        return currentLanguage;
    },

    /**
     * Translate a key, interpolating `{name}` placeholders from `params`.
     * A missing key returns the key itself and logs a warning — never
     * blank; an untranslated label is a smaller bug than an invisible one.
     * @param {string} key
     * @param {object} [params]
     * @returns {string}
     */
    t(key, params) {
        if (!currentDict || !Object.prototype.hasOwnProperty.call(currentDict, key)) {
            console.warn(`[i18n] Missing translation key: "${key}"`);
            return key;
        }
        return interpolate(currentDict[key], params);
    },

    /**
     * Fill every `[data-i18n]` (textContent), `[data-i18n-title]` (title
     * attribute) and `[data-i18n-aria-label]` (aria-label attribute) element
     * under `root`. The popup only ever needs `document`; `root` is a
     * parameter rather than a bare global reference so this file never
     * touches `document` itself — it works the same whether or not one
     * exists in the calling context.
     * @param {ParentNode} root
     */
    apply(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        root.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = I18n.t(el.getAttribute('data-i18n'));
        });
        root.querySelectorAll('[data-i18n-title]').forEach((el) => {
            el.title = I18n.t(el.getAttribute('data-i18n-title'));
        });
        root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
            el.setAttribute('aria-label', I18n.t(el.getAttribute('data-i18n-aria-label')));
        });
    },
};
