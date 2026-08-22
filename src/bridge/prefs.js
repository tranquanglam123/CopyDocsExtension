/**
 * language.js — chrome.storage/chrome.i18n wrapper for the popup's language
 * toggle (spec v3 §5.2/§5.5).
 *
 * src/shared/i18n.js must stay chrome-free (it lives under src/shared/, spec
 * v3 §8: no chrome.*, no imports at all), so persistence and UI-language
 * detection live here instead and are injected into `I18n.init()` by the
 * popup controller (`ui/popup-controller.js`).
 */
import { LOCAL_KEYS } from '../lib/const.js';

/**
 * @returns {Promise<string|null>} The persisted language ('en'|'vi'), or
 *   null if the user has never chosen one.
 */
export async function getStoredLanguage() {
    try {
        const stored = await chrome.storage.local.get(LOCAL_KEYS.LANGUAGE);
        return stored[LOCAL_KEYS.LANGUAGE] || null;
    } catch (err) {
        console.warn('[platform/language] Could not read the persisted language:', err);
        return null;
    }
}

/**
 * @param {string} lang
 * @returns {Promise<void>}
 */
export async function setStoredLanguage(lang) {
    await chrome.storage.local.set({ [LOCAL_KEYS.LANGUAGE]: lang });
}

/**
 * Default language when nothing is persisted yet: `chrome.i18n.getUILanguage()`
 * starting with 'vi' → Vietnamese, otherwise English (spec v3 §5.2).
 * @returns {'en'|'vi'}
 */
export function detectLanguage() {
    try {
        const uiLang = chrome.i18n.getUILanguage() || '';
        return uiLang.toLowerCase().startsWith('vi') ? 'vi' : 'en';
    } catch (err) {
        console.warn('[platform/language] getUILanguage() failed, defaulting to en:', err);
        return 'en';
    }
}
