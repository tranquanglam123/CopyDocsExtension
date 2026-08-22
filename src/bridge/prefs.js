/**
 * User preferences. lib/i18n stays chrome-free, so persistence and UI-language
 * detection live here and are injected into `I18n.init()` by the popup.
 */
import { LOCAL_KEYS } from '../lib/const.js';

/** @returns {Promise<string|null>} 'en' | 'vi', or null if never chosen. */
export async function getStoredLanguage() {
    try {
        const stored = await chrome.storage.local.get(LOCAL_KEYS.LANGUAGE);
        return stored[LOCAL_KEYS.LANGUAGE] || null;
    } catch (err) {
        console.warn('[prefs] Could not read the persisted language:', err);
        return null;
    }
}

/** @param {string} lang @returns {Promise<void>} */
export async function setStoredLanguage(lang) {
    await chrome.storage.local.set({ [LOCAL_KEYS.LANGUAGE]: lang });
}

/** Default when nothing is persisted: a 'vi' UI language, else English. */
export function detectLanguage() {
    try {
        const uiLang = chrome.i18n.getUILanguage() || '';
        return uiLang.toLowerCase().startsWith('vi') ? 'vi' : 'en';
    } catch (err) {
        console.warn('[prefs] getUILanguage() failed, defaulting to en:', err);
        return 'en';
    }
}

/** @returns {Promise<boolean>} Defaults to on, including on a read failure. */
export async function getEmbedImages() {
    try {
        const stored = await chrome.storage.local.get(LOCAL_KEYS.EMBED_IMAGES);
        const value = stored[LOCAL_KEYS.EMBED_IMAGES];
        return value === undefined ? true : !!value;
    } catch (err) {
        console.warn('[prefs] Could not read embed-images, defaulting to ON:', err);
        return true;
    }
}

/** @param {boolean} enabled @returns {Promise<void>} */
export async function setEmbedImages(enabled) {
    await chrome.storage.local.set({ [LOCAL_KEYS.EMBED_IMAGES]: enabled });
}
