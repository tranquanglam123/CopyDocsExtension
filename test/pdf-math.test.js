import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEquation, readable, splitWords } from '../src/lib/pdf-math.js';

// Glyph runs and paths as offscreen/file/pdf.js reads them from a MathType
// equation: 12pt, baseline-down page points.
const g = (str, x, y, extra = {}) => ({ str, x, y, w: str.length * 6, h: 12, ...extra });
const bar = (x0, x1, y) => ({ x0, x1, y0: y - 0.25, y1: y + 0.25, points: [[x0, y], [x1, y]], stroke: true, fill: null });

describe('buildEquation', () => {

    test('what sits over a bar is the numerator, what sits under it the denominator', () => {
        const eq = buildEquation([
            g('2', 100, 94), g('x', 106, 94, { italic: true }), g('+', 112, 94), g('1', 118, 94),
            g('x', 103, 110, { italic: true }), g('−', 109, 110), g('3', 115, 110),
        ], [bar(99, 125, 98)]);
        assert.equal(eq.linear, '(2x+1)/(x−3)');
        assert.match(eq.omml, /^<m:oMath><m:f><m:num>.*<m:t>2<\/m:t>.*<\/m:num><m:den>.*<m:t>3<\/m:t><\/m:r><\/m:den><\/m:f><\/m:oMath>$/);
        // On the fraction's axis, a quarter em under the bar.
        assert.ok(Math.abs(eq.baseline - (98 + 0.27 * 12)) < 0.01);
    });

    test('a smaller raised glyph is a superscript of what precedes it', () => {
        const eq = buildEquation([
            g('4', 100, 94), g('x', 106, 94, { italic: true }), { ...g('2', 112, 89), h: 7, w: 4 },
            g('y', 106, 110, { italic: true }),
        ], [bar(99, 118, 98)]);
        assert.equal(eq.linear, '4x²/y');
        assert.match(eq.omml, /<m:sSup><m:e>.*x.*<\/m:e><m:sup>.*2.*<\/m:sup><\/m:sSup>/);
    });

    test('a hooked outline over glyphs is a radical over them', () => {
        const radical = { x0: 100, y0: 85, x1: 120, y1: 99, fill: '#000000', points: [[100, 95], [103, 99], [106, 85], [120, 85], [120, 86], [107, 86], [103, 99]] };
        const eq = buildEquation([g('x', 108, 97, { italic: true })], [radical]);
        assert.equal(eq.linear, '√x');
        assert.match(eq.omml, /<m:rad><m:radPr><m:degHide m:val="1"\/><\/m:radPr><m:deg\/><m:e>.*x.*<\/m:e><\/m:rad>/);
    });

    test('a fraction under a radical nests in it', () => {
        const radical = { x0: 98, y0: 80, x1: 130, y1: 114, fill: '#000000', points: [[98, 105], [102, 114], [106, 80], [130, 80]] };
        const eq = buildEquation([g('1', 115, 94), g('2', 115, 110)], [radical, bar(110, 126, 98)]);
        assert.equal(eq.linear, '√(1/2)');
        assert.match(eq.omml, /<m:rad>.*<m:e><m:f>.*<\/m:f><\/m:e><\/m:rad>/);
    });

    test('a stretched fence drawn in Symbol pieces wraps what is between', () => {
        const eq = buildEquation([
            g('M', 90, 100, { italic: true }),
            g('', 100, 93, { w: 4 }), g('', 100, 109, { w: 4 }),
            g('1', 106, 94), g('2', 106, 110),
            g('', 114, 93, { w: 4 }), g('', 114, 109, { w: 4 }),
        ], [bar(105, 113, 98)]);
        assert.equal(eq.linear, 'M(1/2)');
        assert.match(eq.omml, /<m:d><m:dPr><m:begChr m:val="\("\/><m:endChr m:val="\)"\/><\/m:dPr><m:e><m:f>/);
    });

    test('an MT Extra arc over a letter is its accent', () => {
        const eq = buildEquation([g('', 100, 96), g('M', 100, 100, { italic: true }), g('=', 110, 100), g('D', 120, 100, { italic: true })], []);
        assert.equal(eq.linear, 'M̑=D');
        assert.match(eq.omml, /<m:acc><m:accPr><m:chr m:val="̑"\/><\/m:accPr><m:e>.*M.*<\/m:e><\/m:acc>/);
    });

    test('lines a derivation stacks become rows', () => {
        // The second line ends in a fraction, which is what makes this an equation at all.
        const eq = buildEquation([
            g('⇒', 100, 100), g('a', 112, 100, { italic: true }), g('=', 120, 100), g('b', 128, 100, { italic: true }),
            g('⇒', 100, 130), g('b', 112, 130, { italic: true }), g('=', 120, 130),
            g('c', 134, 123, { italic: true }), g('2', 134, 139),
        ], [bar(132, 142, 127)]);
        assert.match(eq.omml, /<m:eqArr><m:e>.*a.*<\/m:e><m:e>.*c.*<\/m:e><\/m:eqArr>/);
        assert.equal(eq.linear.split('; ').length, 2);
    });

    test('glyphs with no bar, radical, fence or accent are no equation: they read fine as text', () => {
        assert.equal(buildEquation([g('x', 100, 100), g('=', 108, 100), g('2', 116, 100)], []), null);
    });

    test('a shape that is no radical (a drawing) gives up', () => {
        const slash = { x0: 100, y0: 90, x1: 104, y1: 100, points: [[100, 100], [104, 90]], stroke: true };
        assert.equal(buildEquation([g('x', 110, 100)], [slash]), null);
    });

    test('runs and markup are escaped for XML', () => {
        const eq = buildEquation([g('a<b', 100, 94), g('1', 100, 110)], [bar(99, 120, 98)]);
        assert.match(eq.omml, /a&lt;b/);
    });
});

describe('readable', () => {

    test('a private-use glyph is unreadable unless it is a fence piece or an arc', () => {
        assert.equal(readable([g('x', 0, 0), g('', 0, 0), g('', 0, 0)]), true);
        assert.equal(readable([g('', 0, 0)]), false);
    });
});

describe('splitWords', () => {

    test('a run with spaces becomes its words, placed in proportion to their length', () => {
        assert.deepEqual(splitWords(g('AH AH', 100, 0)).map((w) => [w.str, w.x, w.w]), [['AH', 100, 12], ['AH', 118, 12]]);
        assert.equal(splitWords(g('x', 0, 0)).length, 1);
    });
});
