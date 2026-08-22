/**
 * Unit tests for background/extract/image.js — pure parts only.
 *
 * `ImageEmbedder.embedImages` takes an injectable `fetchFn`
 * (`{url, tabId}) => Promise<{ok, base64, byteLength, contentType}>`) so
 * these tests never touch `lib/transport.js`'s real `fetchBinary` (which
 * needs `fetch`/`chrome.scripting` and is exercised manually — see
 * test/MANUAL-CHECKLIST.md Path D). Zero dependencies, run with:
 *
 *   node --test test/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageEmbedder } from '../src/background/extract/image.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** A 1x1 transparent PNG, base64-encoded — small, real, deterministic. */
const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_BYTE_LENGTH = Buffer.from(TINY_PNG_BASE64, 'base64').byteLength;

/**
 * Build a `fetchFn` from a plain map of url -> response (or a function of
 * url -> response, for tests that need per-call behaviour).
 * @param {object|Function} handler
 */
function makeFetchFn(handler) {
    return async ({ url }) => {
        const res = typeof handler === 'function' ? handler(url) : handler[url];
        if (!res) throw new Error(`unexpected fetch of ${url}`);
        return res;
    };
}

function okImage(byteLength = TINY_PNG_BYTE_LENGTH, contentType = 'image/png') {
    return { ok: true, base64: TINY_PNG_BASE64, byteLength, contentType };
}

// ─── collectGoogleImages — URL collection ───────────────────────────────

describe('ImageEmbedder.collectGoogleImages', () => {
    test('collects only docs.google.com <img> sources', () => {
        const html =
            '<p><img src="https://docs.google.com/docs-images-rt/abc123" width="100"></p>' +
            '<p><img src="https://example.com/logo.png"></p>' +
            '<p><img src="https://not-docs.google.com.evil.com/x.png"></p>' +
            '<p><img src="/relative/path.png"></p>' +
            '<p><img src="data:image/png;base64,AAAA"></p>';

        const images = ImageEmbedder.collectGoogleImages(html);

        assert.equal(images.length, 1);
        assert.equal(images[0].src, 'https://docs.google.com/docs-images-rt/abc123');
    });

    test('collects multiple docs.google.com images in document order', () => {
        const html =
            '<img src="https://docs.google.com/drawings/d/1/image">' +
            '<img src="https://docs.google.com/docs-images-rt/2">' +
            '<img src="https://docs.google.com/docs-images-rt/3">';

        const images = ImageEmbedder.collectGoogleImages(html);

        assert.equal(images.length, 3);
        assert.deepEqual(images.map((i) => i.src), [
            'https://docs.google.com/drawings/d/1/image',
            'https://docs.google.com/docs-images-rt/2',
            'https://docs.google.com/docs-images-rt/3',
        ]);
    });

    test('ignores <img> tags with no src attribute', () => {
        const html = '<img width="10" height="10">';
        assert.deepEqual(ImageEmbedder.collectGoogleImages(html), []);
    });

    test('returns an empty array for html with no images', () => {
        assert.deepEqual(ImageEmbedder.collectGoogleImages('<p>no images here</p>'), []);
    });

    test('returns an empty array for empty/non-string input', () => {
        assert.deepEqual(ImageEmbedder.collectGoogleImages(''), []);
        assert.deepEqual(ImageEmbedder.collectGoogleImages(null), []);
        assert.deepEqual(ImageEmbedder.collectGoogleImages(undefined), []);
    });

    test('start/end offsets point at the exact <img> tag substring', () => {
        const html = '<p>before</p><img src="https://docs.google.com/docs-images-rt/1"><p>after</p>';
        const [img] = ImageEmbedder.collectGoogleImages(html);
        assert.equal(html.slice(img.start, img.end), img.tag);
        assert.ok(img.tag.startsWith('<img'));
    });
});

// ─── embedImages — content-type guard (image_not_bitmap) ───────────────

describe('ImageEmbedder.embedImages — content-type guard', () => {
    test('a non-image/* content type leaves src untouched and emits image_not_bitmap', async () => {
        const src = 'https://docs.google.com/drawings/d/abc/image';
        const html = `<img src="${src}" width="200" height="100">`;

        const fetchFn = makeFetchFn({
            [src]: { ok: true, base64: 'PGh0bWw+', byteLength: 8, contentType: 'text/html; charset=utf-8' },
        });

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, { fetchFn, tabId: 1 });

        assert.equal(bodyHtml, html, 'src/width/height must be byte-for-byte unchanged');
        assert.equal(stats.notBitmap, 1);
        assert.equal(stats.embedded, 0);
        assert.ok(stats.warnings.includes('image_not_bitmap:1'));
    });

    test('an image/* content type is embedded as a data: URI, other attributes preserved', async () => {
        const src = 'https://docs.google.com/docs-images-rt/xyz';
        const html = `<img src="${src}" width="42" height="24" style="display:block">`;

        const fetchFn = makeFetchFn({ [src]: okImage() });

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, { fetchFn, tabId: 1 });

        assert.equal(stats.embedded, 1);
        assert.equal(stats.notBitmap, 0);
        assert.equal(stats.failed, 0);
        assert.ok(bodyHtml.includes(`src="data:image/png;base64,${TINY_PNG_BASE64}"`));
        assert.ok(bodyHtml.includes('width="42"'), 'width attribute must survive');
        assert.ok(bodyHtml.includes('height="24"'), 'height attribute must survive');
        assert.ok(bodyHtml.includes('style="display:block"'), 'inline style must survive');
        assert.ok(!bodyHtml.includes(src), 'the original googleusercontent-style URL must be gone');
    });
});

// ─── embedImages — budgets ───────────────────────────────────────────────

describe('ImageEmbedder.embedImages — budgets', () => {
    test('an image over the per-image cap is skipped and emits image_budget_exceeded', async () => {
        const src = 'https://docs.google.com/docs-images-rt/huge';
        const html = `<img src="${src}">`;

        const fetchFn = makeFetchFn({
            [src]: okImage(5 * 1024 * 1024), // 5 MB > 4 MB per-image cap
        });

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, {
            fetchFn, tabId: 1, perImageMaxBytes: 4 * 1024 * 1024,
        });

        assert.equal(bodyHtml, html);
        assert.equal(stats.embedded, 0);
        assert.equal(stats.budgetExceeded, true);
        assert.ok(stats.warnings.includes('image_budget_exceeded'));
    });

    test('the total budget stops embedding further images once exhausted', async () => {
        const srcs = [
            'https://docs.google.com/docs-images-rt/1',
            'https://docs.google.com/docs-images-rt/2',
            'https://docs.google.com/docs-images-rt/3',
        ];
        const html = srcs.map((s) => `<img src="${s}">`).join('');

        // Each image reports 400 bytes; total budget only fits one.
        const fetchFn = makeFetchFn(
            Object.fromEntries(srcs.map((s) => [s, okImage(400)]))
        );

        const { stats } = await ImageEmbedder.embedImages(html, {
            fetchFn,
            tabId: 1,
            budgetBytes: 400,
            maxConcurrent: 1, // deterministic ordering for this assertion
        });

        assert.equal(stats.totalFound, 3);
        assert.equal(stats.embedded, 1, 'only the first image fits the 400-byte total budget');
        assert.equal(stats.budgetExceeded, true);
        assert.ok(stats.warnings.includes('image_budget_exceeded'));
    });

    test('images already past a hit budget are skipped without being fetched', async () => {
        const srcs = [
            'https://docs.google.com/docs-images-rt/1',
            'https://docs.google.com/docs-images-rt/2',
        ];
        const html = srcs.map((s) => `<img src="${s}">`).join('');

        let fetchCalls = 0;
        const fetchFn = async ({ url }) => {
            fetchCalls++;
            return okImage(1000); // first one alone already exceeds the 500-byte budget
        };

        const { stats } = await ImageEmbedder.embedImages(html, {
            fetchFn, tabId: 1, budgetBytes: 500, maxConcurrent: 1,
        });

        assert.equal(stats.embedded, 0);
        assert.equal(fetchCalls, 1, 'the second image must never be fetched once the budget is blown');
        assert.equal(stats.budgetExceeded, true);
    });
});

// ─── embedImages — failed fetches ────────────────────────────────────────

describe('ImageEmbedder.embedImages — failures', () => {
    test('a failed fetch (ok:false) keeps the original src and emits image_embed_failed', async () => {
        const src = 'https://docs.google.com/docs-images-rt/broken';
        const html = `<img src="${src}" width="10">`;

        const fetchFn = makeFetchFn({
            [src]: { ok: false, base64: '', byteLength: 0, contentType: '' },
        });

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, { fetchFn, tabId: 1 });

        assert.equal(bodyHtml, html);
        assert.equal(stats.failed, 1);
        assert.equal(stats.embedded, 0);
        assert.ok(stats.warnings.includes('image_embed_failed:1'));
    });

    test('a fetchFn that throws keeps the original src and is counted as a failure, not a crash', async () => {
        const src = 'https://docs.google.com/docs-images-rt/throws';
        const html = `<img src="${src}">`;

        const fetchFn = async () => { throw new Error('network exploded'); };

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, { fetchFn, tabId: 1 });

        assert.equal(bodyHtml, html);
        assert.equal(stats.failed, 1);
        assert.ok(stats.warnings.includes('image_embed_failed:1'));
    });

    test('losing one image never loses the rest of the document', async () => {
        const goodSrc = 'https://docs.google.com/docs-images-rt/good';
        const badSrc = 'https://docs.google.com/docs-images-rt/bad';
        const html =
            `<p>before</p><img src="${goodSrc}"><p>middle</p><img src="${badSrc}"><p>after</p>`;

        const fetchFn = makeFetchFn({
            [goodSrc]: okImage(),
            [badSrc]: { ok: false, base64: '', byteLength: 0, contentType: '' },
        });

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, { fetchFn, tabId: 1 });

        assert.ok(bodyHtml.includes('<p>before</p>'));
        assert.ok(bodyHtml.includes('<p>middle</p>'));
        assert.ok(bodyHtml.includes('<p>after</p>'));
        assert.ok(bodyHtml.includes(`data:image/png;base64,${TINY_PNG_BASE64}`));
        assert.ok(bodyHtml.includes(`src="${badSrc}"`));
        assert.equal(stats.embedded, 1);
        assert.equal(stats.failed, 1);
    });
});

// ─── embedImages — no-op paths ────────────────────────────────────────────

describe('ImageEmbedder.embedImages — no-op paths', () => {
    test('html with no docs.google.com images is returned unchanged with zeroed stats', async () => {
        const html = '<p>Just text</p><img src="https://example.com/pic.png">';
        const fetchFn = async () => { throw new Error('should never be called'); };

        const { bodyHtml, stats } = await ImageEmbedder.embedImages(html, { fetchFn, tabId: 1 });

        assert.equal(bodyHtml, html);
        assert.equal(stats.totalFound, 0);
        assert.equal(stats.embedded, 0);
        assert.deepEqual(stats.warnings, []);
    });

    test('empty bodyHtml is returned unchanged', async () => {
        const { bodyHtml, stats } = await ImageEmbedder.embedImages('', { tabId: 1 });
        assert.equal(bodyHtml, '');
        assert.equal(stats.totalFound, 0);
    });
});
