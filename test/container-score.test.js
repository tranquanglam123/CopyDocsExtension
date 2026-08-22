import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerScore } from '../src/lib/score.js';

// Pure scoring logic for the structural container-detection fallback
// (spec §4.3): score = textLength * (1 - linkDensity) * (1 + 0.1 * paragraphCount),
// excluding nav/header/footer/aside. No DOM involved — the offscreen
// parser's _scoreCandidates() is the thin DOM-walking wrapper that measures
// real elements and feeds them here.

describe('ContainerScore.scoreCandidate', () => {
    test('matches the spec formula for a plain candidate', () => {
        // textLength=1000, linkTextLength=0, paragraphCount=5, tagName=DIV
        // score = 1000 * (1 - 0) * (1 + 0.1*5) = 1000 * 1.5 = 1500
        const score = ContainerScore.scoreCandidate({
            textLength: 1000, linkTextLength: 0, paragraphCount: 5, tagName: 'DIV',
        });
        assert.equal(score, 1500);
    });

    test('link density reduces the score proportionally', () => {
        // textLength=1000, linkTextLength=500 -> linkDensity=0.5
        // score = 1000 * 0.5 * (1 + 0.1*0) = 500
        const score = ContainerScore.scoreCandidate({
            textLength: 1000, linkTextLength: 500, paragraphCount: 0, tagName: 'DIV',
        });
        assert.equal(score, 500);
    });

    test('a fully-links candidate (nav-like) scores to zero', () => {
        const score = ContainerScore.scoreCandidate({
            textLength: 1000, linkTextLength: 1000, paragraphCount: 10, tagName: 'DIV',
        });
        assert.equal(score, 0);
    });

    test('excludes nav/header/footer/aside regardless of content', () => {
        for (const tagName of ['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'nav', 'Header']) {
            const score = ContainerScore.scoreCandidate({
                textLength: 100000, linkTextLength: 0, paragraphCount: 50, tagName,
            });
            assert.equal(score, -Infinity, `expected ${tagName} to be excluded`);
        }
    });

    test('more paragraphs raise the score (structural signal)', () => {
        const flat = ContainerScore.scoreCandidate({ textLength: 500, linkTextLength: 0, paragraphCount: 0, tagName: 'DIV' });
        const structured = ContainerScore.scoreCandidate({ textLength: 500, linkTextLength: 0, paragraphCount: 20, tagName: 'DIV' });
        assert.ok(structured > flat);
    });

    test('defaults to zero-ish inputs when fields are missing', () => {
        assert.equal(ContainerScore.scoreCandidate({}), 0);
        assert.equal(ContainerScore.scoreCandidate(), 0);
    });

    test('clamps out-of-range linkTextLength (bad measurement) instead of going negative', () => {
        // linkTextLength > textLength should clamp to 100% link density, not overshoot to a negative score.
        const score = ContainerScore.scoreCandidate({
            textLength: 100, linkTextLength: 9999, paragraphCount: 0, tagName: 'DIV',
        });
        assert.equal(score, 0);
    });

    test('negative paragraphCount does not invert the bonus below 1x', () => {
        const score = ContainerScore.scoreCandidate({
            textLength: 100, linkTextLength: 0, paragraphCount: -5, tagName: 'DIV',
        });
        assert.equal(score, 100); // bonus clamped to 1 + 0.1*0, not 1 + 0.1*(-5)
    });
});

describe('ContainerScore.pickBest', () => {
    test('picks the highest-scoring candidate', () => {
        const candidates = [
            { id: 'low', textLength: 100, linkTextLength: 0, paragraphCount: 0, tagName: 'DIV' },
            { id: 'high', textLength: 5000, linkTextLength: 0, paragraphCount: 30, tagName: 'DIV' },
            { id: 'mid', textLength: 1000, linkTextLength: 200, paragraphCount: 5, tagName: 'DIV' },
        ];
        const result = ContainerScore.pickBest(candidates);
        assert.equal(result.candidate.id, 'high');
        assert.ok(result.score > 0);
    });

    test('never picks an excluded tag even if it looks content-rich', () => {
        const candidates = [
            { id: 'nav-heavy', textLength: 5000, linkTextLength: 0, paragraphCount: 30, tagName: 'NAV' },
            { id: 'small-real', textLength: 200, linkTextLength: 0, paragraphCount: 2, tagName: 'DIV' },
        ];
        const result = ContainerScore.pickBest(candidates);
        assert.equal(result.candidate.id, 'small-real');
    });

    test('returns null for an empty list', () => {
        assert.equal(ContainerScore.pickBest([]), null);
    });

    test('returns null when every candidate is excluded', () => {
        const candidates = [
            { id: 'a', textLength: 500, tagName: 'NAV' },
            { id: 'b', textLength: 500, tagName: 'FOOTER' },
        ];
        assert.equal(ContainerScore.pickBest(candidates), null);
    });

    test('non-array input returns null instead of throwing', () => {
        assert.equal(ContainerScore.pickBest(null), null);
        assert.equal(ContainerScore.pickBest(undefined), null);
    });

    test('preserves arbitrary payload fields on the winning candidate', () => {
        const el = { fake: 'dom-element-ref' };
        const candidates = [
            { ref: el, textLength: 1000, linkTextLength: 0, paragraphCount: 3, tagName: 'DIV' },
        ];
        const result = ContainerScore.pickBest(candidates);
        assert.equal(result.candidate.ref, el);
    });
});
