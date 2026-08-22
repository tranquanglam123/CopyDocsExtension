/**
 * Runtime English/Vietnamese switching. Chrome's `_locales` resolves from the
 * browser UI language and cannot switch at runtime, so this replaces it.
 *
 * Dictionaries are ES modules, not JSON: no fetch, no
 * `web_accessible_resources`, and they load the same in every realm.
 *
 * Persistence and UI-language detection need chrome, which lib/ may not call,
 * so bridge/prefs.js injects them into `init()`.
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
     * Persisted language, else detected, else English. Both dependencies are
     * optional, so this works with no arguments at all.
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

        // Already persisted, or nothing to persist yet.
        await applyLanguage(SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE, { persist: false });
    },

    /**
     * Persists via the setter `init()` was given. Callers re-render after it
     * resolves.
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
     * Interpolates `{name}` from `params`. A missing key returns the key —
     * an untranslated label is a smaller bug than an invisible one.
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
     * Fill `[data-i18n]`, `[data-i18n-title]` and `[data-i18n-aria-label]`
     * under `root`. `root` is a parameter so this file never names `document`.
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
