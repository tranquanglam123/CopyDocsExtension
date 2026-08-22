import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StyleFill } from '../src/lib/style.js';

// This is the spec v2.1 §9 coverage: StyleFill is pure logic (plain
// strings/objects, no DOM), so it is fully testable under `node --test`
// even though the thing it exists to get right — a real CSS cascade
// resolved via getComputedStyle inside a sandboxed iframe — cannot run
// here at all. offscreen/parser.js is the only caller that ever touches a
// real DOM; see test/MANUAL-CHECKLIST.md for the end-to-end verification
// (acceptance criterion 3: `bodyHtml` actually contains
// `background-color:#c00000` and `border-top-color:#ee822f` after a real
// browser resolves the cascade) that cannot be proven here.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'mobilebasic-table.html');
const fixtureHtml = readFileSync(FIXTURE_PATH, 'utf8');

// The real header-cell style quoted verbatim in docs/SPEC-v2.1-format-fidelity.md
// §1, with the spec's elided "…" filled in (matching border-right/-bottom/-left
// longhands — see the comment in the fixture next to this cell). Kept here as a
// literal so parseStyleString/filterDenied/buildElementStyle are exercised
// against the *exact* production string, not an invented one.
const HEADER_CELL_STYLE =
    'background-color:#c00000;border-top-width:1pt;border-top-style:solid;border-top-color:#ee822f;' +
    'border-right-width:1pt;border-right-style:solid;border-right-color:#ee822f;' +
    'border-bottom-width:1pt;border-bottom-style:solid;border-bottom-color:#ee822f;' +
    'border-left-width:1pt;border-left-style:solid;border-left-color:#ee822f;' +
    'width:30.6pt;padding:0pt 5.4pt 0pt 5.4pt;vertical-align:top';

describe('fixture sanity', () => {
    test('the real header-cell style from spec §1 is actually present in the fixture', () => {
        assert.ok(
            fixtureHtml.includes(HEADER_CELL_STYLE),
            'test/fixtures/mobilebasic-table.html drifted from the literal these tests assume'
        );
    });
});

describe('StyleFill.parseStyleString / serializeStyle', () => {
    test('parses the real header-cell style (spec §1) into every declared longhand', () => {
        const parsed = StyleFill.parseStyleString(HEADER_CELL_STYLE);
        assert.equal(parsed['background-color'], '#c00000');
        assert.equal(parsed['border-top-width'], '1pt');
        assert.equal(parsed['border-top-style'], 'solid');
        assert.equal(parsed['border-top-color'], '#ee822f');
        assert.equal(parsed['border-right-color'], '#ee822f');
        assert.equal(parsed['border-bottom-color'], '#ee822f');
        assert.equal(parsed['border-left-color'], '#ee822f');
        assert.equal(parsed.width, '30.6pt');
        assert.equal(parsed.padding, '0pt 5.4pt 0pt 5.4pt');
        assert.equal(parsed['vertical-align'], 'top');
    });

    test('a quoted font-family value is not split on internal characters', () => {
        const parsed = StyleFill.parseStyleString('font-family:"Times New Roman";color:#000000');
        assert.equal(parsed['font-family'], '"Times New Roman"');
        assert.equal(parsed.color, '#000000');
    });

    test('single-quoted font-family also parses correctly', () => {
        const parsed = StyleFill.parseStyleString("font-family:'Times New Roman';font-size:14pt");
        assert.equal(parsed['font-family'], "'Times New Roman'");
        assert.equal(parsed['font-size'], '14pt');
    });

    test('empty, missing, or garbage input returns an empty object, never throws', () => {
        assert.deepEqual(StyleFill.parseStyleString(''), {});
        assert.deepEqual(StyleFill.parseStyleString(undefined), {});
        assert.deepEqual(StyleFill.parseStyleString(null), {});
        assert.deepEqual(StyleFill.parseStyleString(';;;'), {});
    });

    test('serializeStyle round-trips parseStyleString for the real header-cell style', () => {
        const roundTripped = StyleFill.serializeStyle(StyleFill.parseStyleString(HEADER_CELL_STYLE));
        // Re-parsing the round-tripped string must yield the identical map —
        // this is the property that matters, not byte-for-byte string equality.
        assert.deepEqual(StyleFill.parseStyleString(roundTripped), StyleFill.parseStyleString(HEADER_CELL_STYLE));
    });

    test('serializeStyle skips empty/nullish values and joins with ;', () => {
        assert.equal(
            StyleFill.serializeStyle({ color: '#c00000', 'background-color': '', width: null, height: undefined }),
            'color:#c00000'
        );
    });

    test('serializeStyle on an empty object is an empty string', () => {
        assert.equal(StyleFill.serializeStyle({}), '');
        assert.equal(StyleFill.serializeStyle(), '');
    });
});

describe('StyleFill.filterDenied — blocklist, not whitelist (spec §3.1)', () => {
    test('every STYLE_DENY property is removed', () => {
        const authored = {
            position: 'absolute',
            float: 'left',
            clear: 'both',
            overflow: 'hidden',
            'overflow-x': 'auto',
            'overflow-y': 'auto',
            'z-index': '10',
            transform: 'rotate(3deg)',
            visibility: 'hidden',
            display: 'inline-block',
            cursor: 'pointer',
            'user-select': 'none',
            '-webkit-user-select': 'none',
            'pointer-events': 'none',
            'max-width': '770px',
            'min-width': '10px',
            'max-height': '500px',
            'min-height': '10px',
        };
        assert.deepEqual(StyleFill.filterDenied(authored), {});
    });

    test('a blocklist keeps whatever Google adds next — an unrecognised property survives untouched', () => {
        const authored = { 'some-brand-new-css-property': 'sparkles', color: '#c00000' };
        assert.deepEqual(StyleFill.filterDenied(authored), authored);
    });

    test('keeps color while dropping display/position/max-width from the same declaration (the fixture .noise-wrap case)', () => {
        const parsed = StyleFill.parseStyleString(
            'display:inline-block;position:absolute;max-width:770px;color:#000000'
        );
        assert.deepEqual(StyleFill.filterDenied(parsed), { color: '#000000' });
    });

    test('a real border/background/width declaration is entirely unaffected — none of it is on the deny list', () => {
        const parsed = StyleFill.parseStyleString(HEADER_CELL_STYLE);
        assert.deepEqual(StyleFill.filterDenied(parsed), parsed);
    });
});

describe('StyleFill.isMeaninglessDefault (spec §3.3 last paragraph)', () => {
    test('rgba(0, 0, 0, 0) background-color is meaningless', () => {
        assert.equal(StyleFill.isMeaninglessDefault('background-color', 'rgba(0, 0, 0, 0)'), true);
        assert.equal(StyleFill.isMeaninglessDefault('background-color', 'transparent'), true);
    });

    test('a real background-color is not meaningless', () => {
        assert.equal(StyleFill.isMeaninglessDefault('background-color', 'rgb(192, 0, 0)'), false);
    });

    test('text-decoration-line: none is meaningless; underline is not', () => {
        assert.equal(StyleFill.isMeaninglessDefault('text-decoration-line', 'none'), true);
        assert.equal(StyleFill.isMeaninglessDefault('text-decoration-line', 'underline'), false);
    });

    test('font-weight normal/400 is meaningless; 700 is not', () => {
        assert.equal(StyleFill.isMeaninglessDefault('font-weight', 'normal'), true);
        assert.equal(StyleFill.isMeaninglessDefault('font-weight', '400'), true);
        assert.equal(StyleFill.isMeaninglessDefault('font-weight', '700'), false);
    });

    test('font-style normal is meaningless; italic is not', () => {
        assert.equal(StyleFill.isMeaninglessDefault('font-style', 'normal'), true);
        assert.equal(StyleFill.isMeaninglessDefault('font-style', 'italic'), false);
    });

    test('a 0px border-*-width is meaningless — but a real border-*-width is the F3 regression check', () => {
        assert.equal(StyleFill.isMeaninglessDefault('border-top-width', '0px'), true);
        assert.equal(StyleFill.isMeaninglessDefault('border-top-width', '0pt'), true);
        // The whole point of F3: a real longhand border width must NOT be
        // treated as a meaningless default.
        assert.equal(StyleFill.isMeaninglessDefault('border-top-width', '1pt'), false);
    });

    test('border-*-style: none is meaningless; solid is not', () => {
        assert.equal(StyleFill.isMeaninglessDefault('border-top-style', 'none'), true);
        assert.equal(StyleFill.isMeaninglessDefault('border-top-style', 'solid'), false);
    });

    test('missing/empty values are meaningless', () => {
        assert.equal(StyleFill.isMeaninglessDefault('color', undefined), true);
        assert.equal(StyleFill.isMeaninglessDefault('color', null), true);
        assert.equal(StyleFill.isMeaninglessDefault('color', ''), true);
        assert.equal(StyleFill.isMeaninglessDefault('color', '   '), true);
    });
});

describe('StyleFill.resolveAppearanceValue — parent-diff decision (spec §3.2 row 2)', () => {
    test('a computed value equal to the parent\'s is dropped (inherited, not restated)', () => {
        assert.equal(
            StyleFill.resolveAppearanceValue({ property: 'font-family', own: '"Calibri"', parent: '"Calibri"' }),
            null
        );
    });

    test('equality is case-insensitive (getComputedStyle keywords are not guaranteed identical casing)', () => {
        assert.equal(
            StyleFill.resolveAppearanceValue({ property: 'text-align', own: 'CENTER', parent: 'center' }),
            null
        );
    });

    test('a border longhand that differs from the parent is kept (the F3 regression)', () => {
        assert.equal(
            StyleFill.resolveAppearanceValue({ property: 'border-top-color', own: 'rgb(238, 130, 47)', parent: 'rgb(0, 0, 0)' }),
            'rgb(238, 130, 47)'
        );
    });

    test('a meaningless default is dropped even though it differs from the parent', () => {
        assert.equal(
            StyleFill.resolveAppearanceValue({ property: 'background-color', own: 'rgba(0, 0, 0, 0)', parent: 'rgb(244, 204, 204)' }),
            null
        );
    });

    test('no parent supplied (root-level element) — a meaningful own value still survives', () => {
        assert.equal(
            StyleFill.resolveAppearanceValue({ property: 'background-color', own: 'rgb(192, 0, 0)' }),
            'rgb(192, 0, 0)'
        );
    });

    test('own value missing/empty always resolves to null', () => {
        assert.equal(StyleFill.resolveAppearanceValue({ property: 'color', own: undefined }), null);
        assert.equal(StyleFill.resolveAppearanceValue({ property: 'color', own: '' }), null);
    });
});

describe('StyleFill.APPEARANCE_PROPERTIES — never a shorthand (F3)', () => {
    const SHORTHANDS = ['border', 'margin', 'padding', 'font', 'background', 'text-decoration', 'list-style'];

    test('no shorthand property name is ever queried', () => {
        for (const shorthand of SHORTHANDS) {
            assert.ok(
                !StyleFill.APPEARANCE_PROPERTIES.includes(shorthand),
                `${shorthand} is a shorthand — getComputedStyle(...).getPropertyValue('${shorthand}') ` +
                'returns "" when only longhands are set, which is exactly the F3 defect'
            );
        }
    });

    test('all four border sides are present as explicit longhands', () => {
        for (const side of ['top', 'right', 'bottom', 'left']) {
            for (const part of ['width', 'style', 'color']) {
                assert.ok(StyleFill.APPEARANCE_PROPERTIES.includes(`border-${side}-${part}`));
            }
        }
    });
});

describe('StyleFill.LAYOUT_PROPERTIES — geometry, authored-only (spec §3.2 row 1)', () => {
    test('covers width/height/margin*/padding*/text-indent', () => {
        for (const prop of ['width', 'height', 'margin-left', 'margin-top', 'padding-left', 'padding-top', 'text-indent']) {
            assert.ok(StyleFill.LAYOUT_PROPERTIES.has(prop), `${prop} missing from LAYOUT_PROPERTIES`);
        }
    });

    test('disjoint from APPEARANCE_PROPERTIES — a property is never fed through both paths', () => {
        for (const prop of StyleFill.APPEARANCE_PROPERTIES) {
            assert.ok(!StyleFill.LAYOUT_PROPERTIES.has(prop), `${prop} is in both LAYOUT_PROPERTIES and APPEARANCE_PROPERTIES`);
        }
    });
});

describe('StyleFill.buildElementStyle — orchestration (spec §3.2)', () => {
    test('denied properties are removed from the authored style', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: 'display:inline-block;position:absolute;color:#000000',
        });
        assert.deepEqual(result, { color: '#000000' });
    });

    test('an inline layout property is kept verbatim, regardless of any computed input', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: 'width:30.6pt;padding:0pt 5.4pt 0pt 5.4pt',
            // A computed width, if it were consulted, would be wildly
            // different (the iframe's used width, not the authored 30.6pt) —
            // proving layout properties never reach the computed branch at
            // all, they simply pass through from the authored text.
            computed: { width: '1000px' },
            parentComputed: { width: '1000px' },
        });
        assert.equal(result.width, '30.6pt');
        assert.equal(result.padding, '0pt 5.4pt 0pt 5.4pt');
    });

    test('margin-left is never filled from computed style when absent from the authored text (spec §3.2 row 1)', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: 'color:#000000',
            computed: { 'margin-left': '36pt' },
            parentComputed: { 'margin-left': '0pt' },
        });
        assert.equal(result['margin-left'], undefined);
    });

    test('a computed value equal to the parent\'s is dropped', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: '',
            computed: { 'font-family': '"Calibri"' },
            parentComputed: { 'font-family': '"Calibri"' },
        });
        assert.equal(result['font-family'], undefined);
    });

    test('meaningless defaults are dropped from the computed fill', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: '',
            computed: {
                'background-color': 'rgba(0, 0, 0, 0)',
                'text-decoration-line': 'none',
                'font-weight': 'normal',
                'border-top-width': '0px',
            },
            parentComputed: {
                'background-color': 'rgb(255, 255, 255)', // differs from own — proves the drop is the meaningless check, not the parent-diff
            },
        });
        assert.equal(result['background-color'], undefined);
        assert.equal(result['text-decoration-line'], undefined);
        assert.equal(result['font-weight'], undefined);
        assert.equal(result['border-top-width'], undefined);
    });

    test('a border longhand that differs from the parent is kept — the F3 regression, end to end', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: '',
            computed: {
                'border-top-width': '1pt',
                'border-top-style': 'solid',
                'border-top-color': 'rgb(238, 130, 47)',
            },
            parentComputed: {
                'border-top-width': '0px',
                'border-top-style': 'none',
                'border-top-color': 'rgb(0, 0, 0)',
            },
        });
        assert.equal(result['border-top-width'], '1pt');
        assert.equal(result['border-top-style'], 'solid');
        assert.equal(result['border-top-color'], 'rgb(238, 130, 47)');
    });

    test('authored wins over computed even when they disagree', () => {
        const result = StyleFill.buildElementStyle({
            authoredStyleText: 'color:#c00000',
            computed: { color: 'rgb(0, 0, 255)' },
            parentComputed: { color: 'rgb(0, 0, 0)' },
        });
        assert.equal(result.color, '#c00000');
    });

    test('the fixture\'s class-driven .row-shade cell: no inline background-color, only computed+parent-diff can recover it', () => {
        // Mirrors test/fixtures/mobilebasic-table.html: the data cell has
        // class="row-shade" and NO inline background-color at all — the
        // authored style text genuinely does not contain it.
        const result = StyleFill.buildElementStyle({
            authoredStyleText: 'padding:0pt 5.4pt 0pt 5.4pt;vertical-align:top',
            computed: { 'background-color': 'rgb(244, 204, 204)' },
            parentComputed: { 'background-color': 'rgba(0, 0, 0, 0)' },
        });
        assert.equal(result['background-color'], 'rgb(244, 204, 204)');
        // Layout properties from the authored text still pass through untouched.
        assert.equal(result.padding, '0pt 5.4pt 0pt 5.4pt');
    });

    test('the real header-cell style (spec §1) survives buildElementStyle unchanged when there is no computed input', () => {
        const result = StyleFill.buildElementStyle({ authoredStyleText: HEADER_CELL_STYLE });
        assert.equal(result['background-color'], '#c00000');
        assert.equal(result['border-top-color'], '#ee822f');
        assert.equal(result['border-right-color'], '#ee822f');
        assert.equal(result['border-bottom-color'], '#ee822f');
        assert.equal(result['border-left-color'], '#ee822f');
        assert.equal(result.width, '30.6pt');
    });
});
