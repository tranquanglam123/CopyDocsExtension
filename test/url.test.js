import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UrlTransformer } from '../src/lib/url.js';

describe('UrlTransformer', () => {

    test('Google documents keep their types and ids', () => {
        assert.deepEqual(UrlTransformer.identify('https://docs.google.com/document/d/AB_c-1/edit'), { isValid: true, type: 'docs' });
        assert.equal(UrlTransformer.getDocId('https://docs.google.com/spreadsheets/d/S1/edit#gid=0'), 'S1');
        assert.equal(UrlTransformer.isGoogleDoc('https://docs.google.com/presentation/d/P1/edit'), true);
    });

    test('any other http(s) page is `web`, its id the URL without the fragment', () => {
        const url = 'https://thcs.toanmath.com/2026/05/de.html#comments';
        assert.deepEqual(UrlTransformer.identify(url), { isValid: true, type: 'web' });
        assert.equal(UrlTransformer.getDocId(url), 'https://thcs.toanmath.com/2026/05/de.html');
        assert.equal(UrlTransformer.isGoogleDoc(url), false);
        assert.equal(UrlTransformer.getTypeLabel(url), 'Web page');
    });

    test('a published /d/e/ copy is a web page, not a document id of "e"', () => {
        const url = 'https://docs.google.com/document/d/e/2PACX-1v/pub';
        assert.equal(UrlTransformer.identify(url).type, 'web');
    });

    test('browser pages and empty input are not valid', () => {
        assert.deepEqual(UrlTransformer.identify('chrome://extensions'), { isValid: false, type: null });
        assert.deepEqual(UrlTransformer.identify(''), { isValid: false, type: null });
        assert.equal(UrlTransformer.getDocId(undefined), null);
    });
});
