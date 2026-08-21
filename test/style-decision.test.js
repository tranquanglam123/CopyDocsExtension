import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StyleDecision } from '../src/core/style-decision.js';

// This is the D2 decision-logic coverage: given values as they'd come back
// from getComputedStyle() (numeric weight strings, resolved keywords),
// decide which semantic tag the formatting maps to. No DOM involved —
// the offscreen parser is the thing that supplies real computed-style
// values; see test/MANUAL-CHECKLIST.md for the end-to-end (real cascade)
// verification that can't run under plain `node --test`.

describe('StyleDecision.isBold', () => {
    test('numeric string weights >= 600 are bold', () => {
        assert.equal(StyleDecision.isBold('700'), true);
        assert.equal(StyleDecision.isBold('600'), true);
        assert.equal(StyleDecision.isBold('900'), true);
    });

    test('numeric string weights < 600 are not bold', () => {
        assert.equal(StyleDecision.isBold('500'), false);
        assert.equal(StyleDecision.isBold('400'), false);
        assert.equal(StyleDecision.isBold('100'), false);
    });

    test('numeric (non-string) weights are handled', () => {
        assert.equal(StyleDecision.isBold(700), true);
        assert.equal(StyleDecision.isBold(400), false);
    });

    test('keyword weights', () => {
        assert.equal(StyleDecision.isBold('bold'), true);
        assert.equal(StyleDecision.isBold('bolder'), true);
        assert.equal(StyleDecision.isBold('normal'), false);
    });

    test('missing/empty/garbage values are not bold', () => {
        assert.equal(StyleDecision.isBold(undefined), false);
        assert.equal(StyleDecision.isBold(null), false);
        assert.equal(StyleDecision.isBold(''), false);
        assert.equal(StyleDecision.isBold('not-a-weight'), false);
    });
});

describe('StyleDecision.isItalic', () => {
    test('italic and oblique are italic', () => {
        assert.equal(StyleDecision.isItalic('italic'), true);
        assert.equal(StyleDecision.isItalic('oblique'), true);
    });

    test('oblique with an angle is still italic', () => {
        assert.equal(StyleDecision.isItalic('oblique 14deg'), true);
    });

    test('normal / missing is not italic', () => {
        assert.equal(StyleDecision.isItalic('normal'), false);
        assert.equal(StyleDecision.isItalic(undefined), false);
        assert.equal(StyleDecision.isItalic(''), false);
    });
});

describe('StyleDecision.isUnderline', () => {
    test('plain underline', () => {
        assert.equal(StyleDecision.isUnderline('underline'), true);
    });

    test('underline combined with other decoration lines', () => {
        assert.equal(StyleDecision.isUnderline('underline line-through'), true);
    });

    test('none / missing / other decorations are not underline', () => {
        assert.equal(StyleDecision.isUnderline('none'), false);
        assert.equal(StyleDecision.isUnderline('line-through'), false);
        assert.equal(StyleDecision.isUnderline(undefined), false);
    });
});

describe('StyleDecision.styleFlags', () => {
    test('reports all three flags independently', () => {
        assert.deepEqual(
            StyleDecision.styleFlags({ fontWeight: '700', fontStyle: 'italic', textDecorationLine: 'underline' }),
            { bold: true, italic: true, underline: true }
        );
    });

    test('falls back to the textDecoration shorthand when textDecorationLine is absent', () => {
        assert.deepEqual(
            StyleDecision.styleFlags({ fontWeight: '400', fontStyle: 'normal', textDecoration: 'underline solid rgb(0, 0, 0)' }),
            { bold: false, italic: false, underline: true }
        );
    });

    test('all-default style yields all false', () => {
        assert.deepEqual(
            StyleDecision.styleFlags({ fontWeight: '400', fontStyle: 'normal', textDecorationLine: 'none' }),
            { bold: false, italic: false, underline: false }
        );
    });
});

describe('StyleDecision.styleToTag — the D2 regression contract', () => {
    test('class-based bold (as getComputedStyle would resolve it) maps to b', () => {
        // This is exactly the shape mobilebasic's `.c1{font-weight:700}` resolves to.
        assert.equal(StyleDecision.styleToTag({ fontWeight: '700', fontStyle: 'normal', textDecorationLine: 'none' }), 'b');
    });

    test('class-based italic maps to i', () => {
        assert.equal(StyleDecision.styleToTag({ fontWeight: '400', fontStyle: 'italic', textDecorationLine: 'none' }), 'i');
    });

    test('class-based underline maps to u', () => {
        assert.equal(StyleDecision.styleToTag({ fontWeight: '400', fontStyle: 'normal', textDecorationLine: 'underline' }), 'u');
    });

    test('no formatting maps to null', () => {
        assert.equal(StyleDecision.styleToTag({ fontWeight: '400', fontStyle: 'normal', textDecorationLine: 'none' }), null);
    });

    test('missing style object maps to null', () => {
        assert.equal(StyleDecision.styleToTag(), null);
        assert.equal(StyleDecision.styleToTag({}), null);
    });

    test('priority when multiple flags are true: bold beats italic beats underline', () => {
        assert.equal(
            StyleDecision.styleToTag({ fontWeight: '700', fontStyle: 'italic', textDecorationLine: 'underline' }),
            'b'
        );
        assert.equal(
            StyleDecision.styleToTag({ fontWeight: '400', fontStyle: 'italic', textDecorationLine: 'underline' }),
            'i'
        );
    });
});
