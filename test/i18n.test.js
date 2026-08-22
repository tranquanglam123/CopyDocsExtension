/**
 * Unit tests for shared/i18n.js and the locale dictionaries (spec v3 §5/§8).
 *
 * These must not require Chrome APIs (spec §11) — I18n itself never calls
 * chrome.* (see shared/i18n.js's file header), so `I18n.init()`/`setLanguage()`
 * work here exactly as they do in the popup, just without the
 * platform/language.js dependency injection (persistence/detection are
 * optional — omitting them just leaves the in-memory default).
 *
 *   node --test test/
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { I18n } from '../src/lib/i18n/index.js';
import { dict as en } from '../src/lib/i18n/en.js';
import { dict as vi } from '../src/lib/i18n/vi.js';
import { WARNINGS, WARNING_PREFIXES } from '../src/lib/const.js';

// ─── Dictionary shape ───────────────────────────────────────────────────────

describe('locale dictionaries', () => {

    test('en.js and vi.js have exactly the same key set — a new string cannot ship untranslated', () => {
        const enKeys = Object.keys(en).sort();
        const viKeys = Object.keys(vi).sort();
        assert.deepEqual(viKeys, enKeys);
    });

    test('no value in en.js is an empty string', () => {
        for (const [key, value] of Object.entries(en)) {
            assert.ok(typeof value === 'string' && value.length > 0, `en.js["${key}"] is empty`);
        }
    });

    test('no value in vi.js is an empty string', () => {
        for (const [key, value] of Object.entries(vi)) {
            assert.ok(typeof value === 'string' && value.length > 0, `vi.js["${key}"] is empty`);
        }
    });

    test('every warning code in shared/constants.js (WARNINGS) has a message key in both locales', () => {
        for (const code of Object.values(WARNINGS)) {
            const key = `warning.${code}`;
            assert.ok(key in en, `en.js is missing "${key}"`);
            assert.ok(key in vi, `vi.js is missing "${key}"`);
        }
    });

    test('every warning code in shared/constants.js (WARNING_PREFIXES) has a message key in both locales', () => {
        for (const code of Object.values(WARNING_PREFIXES)) {
            const key = `warning.${code}`;
            assert.ok(key in en, `en.js is missing "${key}"`);
            assert.ok(key in vi, `vi.js is missing "${key}"`);
        }
    });
});

// ─── I18n.t() ───────────────────────────────────────────────────────────────

describe('I18n.t()', () => {

    test('translates a plain key with no params', async () => {
        await I18n.setLanguage('en');
        assert.equal(I18n.t('popup.action.copy'), en['popup.action.copy']);
    });

    test('interpolates a {param} placeholder', async () => {
        await I18n.setLanguage('en');
        assert.equal(
            I18n.t('popup.status.docDetected', { type: 'Google Doc' }),
            'Google Doc detected'
        );
    });

    test('interpolates multiple params, including a numeric one', async () => {
        await I18n.setLanguage('en');
        assert.equal(
            I18n.t('popup.status.extractedDetail', { count: 1234 }),
            '1234 characters extracted'
        );
    });

    test('a missing key returns the key itself (never blank) and logs a warning', async () => {
        await I18n.setLanguage('en');
        const originalWarn = console.warn;
        let warned = false;
        console.warn = () => { warned = true; };
        try {
            const result = I18n.t('this.key.does.not.exist');
            assert.equal(result, 'this.key.does.not.exist');
        } finally {
            console.warn = originalWarn;
        }
        assert.ok(warned, 'expected console.warn to be called for a missing key');
    });

    test('switching language changes what t() returns for the same key', async () => {
        await I18n.setLanguage('en');
        const enText = I18n.t('popup.action.extract');
        await I18n.setLanguage('vi');
        const viText = I18n.t('popup.action.extract');
        assert.equal(enText, en['popup.action.extract']);
        assert.equal(viText, vi['popup.action.extract']);
        assert.notEqual(enText, viText);
        await I18n.setLanguage('en'); // leave state clean for later tests
    });

    test('setLanguage() falls back to English for an unsupported language code', async () => {
        await I18n.setLanguage('fr');
        assert.equal(I18n.getLanguage(), 'en');
    });
});

// ─── I18n.init() ────────────────────────────────────────────────────────────

describe('I18n.init()', () => {

    test('with no dependencies, defaults to English', async () => {
        await I18n.init();
        assert.equal(I18n.getLanguage(), 'en');
    });

    test('prefers a persisted language over detection', async () => {
        await I18n.init({
            getStoredLanguage: async () => 'vi',
            detectLanguage: () => 'en',
        });
        assert.equal(I18n.getLanguage(), 'vi');
    });

    test('falls back to detection when nothing is persisted', async () => {
        await I18n.init({
            getStoredLanguage: async () => null,
            detectLanguage: () => 'vi',
        });
        assert.equal(I18n.getLanguage(), 'vi');
    });

    test('setLanguage() after init() persists via the injected setter', async () => {
        const persisted = [];
        await I18n.init({
            getStoredLanguage: async () => 'en',
            detectLanguage: () => 'en',
            setStoredLanguage: async (lang) => persisted.push(lang),
        });
        await I18n.setLanguage('vi');
        assert.deepEqual(persisted, ['vi']);
        await I18n.setLanguage('en'); // leave state clean for later tests
    });
});

// ─── I18n.apply() ───────────────────────────────────────────────────────────
// Exercises the exact contract `I18n.apply(document)` implies, using a
// minimal fake DOM (Node has no `document`) — apply() only ever calls
// querySelectorAll/getAttribute/setAttribute and reads/writes
// textContent/title, so a fake with just that surface is enough.

function fakeElement(attrs) {
    return {
        attrs,
        textContent: '',
        title: '',
        ariaLabel: null,
        getAttribute(name) { return this.attrs[name]; },
        setAttribute(name, value) { if (name === 'aria-label') this.ariaLabel = value; },
    };
}

function fakeRoot(elements) {
    return {
        querySelectorAll(selector) {
            const attrName = selector.slice(1, -1); // '[data-i18n]' -> 'data-i18n'
            return elements.filter((el) => el.attrs[attrName] !== undefined);
        },
    };
}

describe('I18n.apply()', () => {

    test('fills [data-i18n] textContent, [data-i18n-title] title, and [data-i18n-aria-label] aria-label', async () => {
        await I18n.setLanguage('en');
        const label = fakeElement({ 'data-i18n': 'popup.action.copy' });
        const button = fakeElement({ 'data-i18n-title': 'popup.action.copyTitle' });
        const select = fakeElement({ 'data-i18n-aria-label': 'popup.footer.languageLabel' });
        const root = fakeRoot([label, button, select]);

        I18n.apply(root);

        assert.equal(label.textContent, en['popup.action.copy']);
        assert.equal(button.title, en['popup.action.copyTitle']);
        assert.equal(select.ariaLabel, en['popup.footer.languageLabel']);
    });

    test('does nothing (and does not throw) when given a falsy root', () => {
        assert.doesNotThrow(() => I18n.apply(null));
        assert.doesNotThrow(() => I18n.apply(undefined));
    });
});
