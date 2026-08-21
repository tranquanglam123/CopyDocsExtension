/**
 * Unit tests for lib/transport.js — the pure `detectWall` function only
 * (`swFetch`/`csFetch`/`fetchDocHtml` need live Chrome APIs and are covered
 * by the manual checklist, per spec §11). Zero dependencies, run with:
 *
 *   node --test test/
 *
 * These must not require Chrome APIs (spec §11).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWall } from '../lib/transport.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a body roughly the shape of a real /mobilebasic export: a large
 * <style> block of Google's boilerplate CSS classes plus a lot of prose,
 * optionally with a phrase injected into the prose. Real restricted-doc
 * fixture measured for this fix was 784,354 bytes.
 * @param {string} [extraProse]  Text to splice into the document body.
 * @returns {string}
 */
function buildRealisticMobilebasicBody(extraProse = '') {
    const styleBlock = '.c' + Array.from({ length: 200 }, (_, i) =>
        `${i}{font-weight:700;font-style:normal}`
    ).join('\n.c');
    const paragraph = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(400);
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>My Restricted Document</title>
<style>${styleBlock}</style>
</head>
<body>
<div class="doc-content">
${paragraph}
${extraProse}
${paragraph}
</div>
</body>
</html>`;
}

// ─── The regression test ─────────────────────────────────────────────────

test('detectWall: support.google.com/accounts/answer/32050 redirect is a wall (the production regression)', () => {
    const finalUrl = 'https://support.google.com/accounts/answer/32050?hl=en';
    const html = '<html><head><title>Clear cache &amp; cookies - Computer - Google Account Help</title></head><body>...</body></html>';
    const reason = detectWall(html, finalUrl);
    assert.equal(reason, 'cookies_help_redirect');
});

test('detectWall: support.google.com/accounts/answer/32050 is a wall even without hl= query param', () => {
    const reason = detectWall('<html></html>', 'https://support.google.com/accounts/answer/32050');
    assert.equal(reason, 'cookies_help_redirect');
});

// ─── Login-wall redirects ──────────────────────────────────────────────────

test('detectWall: accounts.google.com redirect is a wall', () => {
    const reason = detectWall('<html></html>', 'https://accounts.google.com/v3/signin/identifier?dsh=123');
    assert.equal(reason, 'login_redirect');
});

test('detectWall: /ServiceLogin redirect is a wall', () => {
    const reason = detectWall('<html></html>', 'https://docs.google.com/ServiceLogin?service=wise');
    assert.equal(reason, 'login_redirect');
});

// ─── Body-text access walls ─────────────────────────────────────────────────

test('detectWall: a small "You need access" body is a wall', () => {
    const html = '<html><head><title>Access denied</title></head><body>You need access to view this document</body></html>';
    const reason = detectWall(html, 'https://docs.google.com/document/d/abc123/mobilebasic');
    assert.equal(reason, 'access_wall_body');
});

test('detectWall: a small "Request access" body is a wall', () => {
    const html = '<html><body><p>Request access</p><p>Ask the owner for permission to view this document.</p></body></html>';
    const reason = detectWall(html, 'https://docs.google.com/document/d/abc123/mobilebasic');
    assert.equal(reason, 'access_wall_body');
});

// ─── Cookies-help page detected by title, not just URL ─────────────────────

test('detectWall: a body whose <title> is the cookies-help page is a wall even with an unrelated finalUrl', () => {
    const html = '<html><head><title>Clear cache and cookies - Computer - Google Account Help</title></head><body></body></html>';
    const reason = detectWall(html, 'https://docs.google.com/document/d/abc123/mobilebasic');
    assert.equal(reason, 'cookies_help_title');
});

// ─── No false positive on a real, large document ────────────────────────────

test('detectWall: a real 784KB-shaped mobilebasic body with a normal finalUrl is NOT a wall', () => {
    const html = buildRealisticMobilebasicBody();
    // Confirm the fixture is genuinely large, in the shape of the real
    // restricted-doc measurement (784,354 bytes) this fix is based on.
    assert.ok(html.length > 20000, `fixture should be large; was ${html.length} bytes`);
    const reason = detectWall(html, 'https://docs.google.com/document/d/abc123/mobilebasic');
    assert.equal(reason, null);
});

// ─── Decision: "request access" inside a document's own prose ──────────────
//
// A genuine Google access-wall page is a few KB of boilerplate. A real
// /mobilebasic export is tens to hundreds of KB even for a short document
// (784,354 bytes for the restricted doc measured for this fix), because of
// Google's CSS/markup overhead. detectWall() gates the "You need access" /
// "Request access" phrase match on body size (SMALL_BODY_WALL_THRESHOLD,
// 20,000 chars) specifically so that a normal-sized document which happens
// to use the words "request access" in its own prose (e.g. a company policy
// doc about requesting building access, or a FAQ) is NOT misdetected as a
// wall. The tradeoff: a wall page host-boilerplate change that pushes it
// above 20KB would also stop being detected by this path alone — that's
// accepted because the URL-based checks above catch the actual production
// failure mode independently of body size.

test('detectWall: "request access" inside a large document\'s own prose is NOT flagged (decision: size-gated)', () => {
    const html = buildRealisticMobilebasicBody(
        '<p>Please note that employees must request access to the server room ' +
        'through the facilities portal before their first visit.</p>'
    );
    assert.ok(html.length > 20000, `fixture should be large; was ${html.length} bytes`);
    const reason = detectWall(html, 'https://docs.google.com/document/d/abc123/mobilebasic');
    assert.equal(reason, null);
});

// ─── Misc ───────────────────────────────────────────────────────────────────

test('detectWall: empty html and finalUrl is not a wall', () => {
    assert.equal(detectWall('', ''), null);
    assert.equal(detectWall(null, null), null);
    assert.equal(detectWall(undefined, undefined), null);
});
