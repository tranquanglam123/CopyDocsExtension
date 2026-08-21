/**
 * Architecture tests (spec v3 §8).
 *
 * A layered structure that is only written down in a document rots — the next
 * person in a hurry puts a `chrome.storage` call in a pure module and nothing
 * complains. These tests are the enforcement, so the layering fails loudly
 * instead of quietly.
 *
 * They read the source as text rather than importing it: most of these modules
 * cannot be imported under Node at all (they reference `chrome`), and the point
 * is to check *where code lives*, not what it computes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Every .js file under a directory, as repo-relative POSIX paths.
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const name of readdirSync(d)) {
            const full = join(d, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith('.js')) out.push(relative(ROOT, full).replace(/\\/g, '/'));
        }
    };
    walk(dir);
    return out;
}

/**
 * Source with comments and string literals blanked out.
 *
 * Without this, `zip.addFile('word/document.xml', …)` in the DOCX writer reads
 * as a `document.` usage, and every JSDoc line that *describes* a chrome API
 * reads as a call. Both are false positives that would make the rules useless.
 *
 * @param {string} src
 * @returns {string}
 */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // line comments (not `://`)
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")  // single-quoted strings
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')  // double-quoted strings
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');   // template literals
}

/**
 * Source with comments removed but string literals intact.
 *
 * `code()` blanks strings, which is the opposite of what the "shared values are
 * literals only in constants.js" rule needs — that rule is *looking for*
 * strings. But it must still ignore a warning code merely named in a JSDoc
 * line, so comments have to go and quotes have to stay.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** @param {string} rel @returns {string} */
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CORE = jsFiles(join(SRC, 'core'));
const EXTRACTION = jsFiles(join(SRC, 'extraction'));
const SHARED = jsFiles(join(SRC, 'shared'));
const ALL_SRC = jsFiles(SRC);

// ─── Layer purity ───────────────────────────────────────────────────────────

describe('layer purity', () => {

    test('core/ never touches chrome.* — it is the layer node --test can exercise', () => {
        for (const file of CORE) {
            assert.ok(
                !/\bchrome\s*\./.test(code(read(file))),
                `${file} calls chrome.* — move that behind src/platform/`
            );
        }
    });

    test('core/ never touches DOM globals', () => {
        // `Blob` is excluded on purpose: it is a standard global in both the
        // browser and Node 18+, and the DOCX writer legitimately produces one.
        for (const file of CORE) {
            const src = code(read(file));
            assert.ok(!/\bDOMParser\b/.test(src), `${file} uses DOMParser`);
            assert.ok(!/\bwindow\s*\./.test(src), `${file} uses window.`);
            assert.ok(
                !/\bdocument\s*\.\s*(getElementById|querySelector|createElement|body|head|title)\b/.test(src),
                `${file} touches the live document`
            );
        }
    });

    test('extraction/ goes through platform/ instead of calling chrome.* directly', () => {
        for (const file of EXTRACTION) {
            assert.ok(
                !/\bchrome\s*\./.test(code(read(file))),
                `${file} calls chrome.* — use a src/platform/ wrapper`
            );
        }
    });

    test('shared/ is the bottom of the graph: no chrome.*, no imports from other layers', () => {
        // An earlier version of this rule banned *every* import in shared/,
        // which is stricter than the intent. shared/ being "the bottom" means
        // nothing above it may be pulled in — not that i18n.js is forbidden
        // from loading its own locale dictionaries. The blunt version pushed
        // a real workaround into the source (a dynamic `import()` chosen to
        // dodge this regex), which is the test shaping the code rather than
        // guarding it.
        const otherLayers = /(core|platform|extraction|services|entry|ui|popup|background|content|offscreen)\//;
        for (const file of SHARED) {
            assert.ok(!/\bchrome\s*\./.test(code(read(file))), `${file} calls chrome.*`);
            for (const spec of [...read(file).matchAll(/import\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])) {
                assert.ok(!otherLayers.test(spec), `${file} imports ${spec} — shared/ sits below every layer`);
            }
        }
    });
});

// ─── Dependency direction ───────────────────────────────────────────────────

describe('dependency direction', () => {

    /** @param {string} rel @returns {string[]} */
    const importsOf = (rel) =>
        [...read(rel).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

    test('core/ imports nothing but shared/', () => {
        for (const file of CORE) {
            for (const spec of importsOf(file)) {
                assert.ok(
                    !/(platform|extraction|entry|ui)\//.test(spec),
                    `${file} imports ${spec} — core/ may only depend on shared/`
                );
            }
        }
    });

    test('platform/ never depends on extraction/, ui/ or entry/', () => {
        for (const file of jsFiles(join(SRC, 'platform'))) {
            for (const spec of importsOf(file)) {
                assert.ok(
                    !/(extraction|ui|entry)\//.test(spec),
                    `${file} imports ${spec} — platform/ sits below those layers`
                );
            }
        }
    });

    test('nothing imports an entry point', () => {
        for (const file of ALL_SRC) {
            for (const spec of importsOf(file)) {
                assert.ok(!spec.includes('entry/'), `${file} imports ${spec}`);
            }
        }
    });

    test('no import climbs three levels — there is no bundler to fix a wrong path', () => {
        for (const file of ALL_SRC) {
            for (const spec of importsOf(file)) {
                assert.ok(!spec.includes('../../..'), `${file} imports ${spec}`);
            }
        }
    });
});

// ─── One implementation per concept ─────────────────────────────────────────

describe('no duplicated concepts', () => {

    test('wrapAsDocument is defined exactly once', () => {
        const definitions = ALL_SRC.filter((f) =>
            /(export\s+(async\s+)?function\s+wrapAsDocument|static\s+wrapAsDocument\s*\()/.test(read(f))
        );
        assert.deepEqual(
            definitions,
            ['src/core/html-document.js'],
            `expected one definition, found: ${definitions.join(', ') || 'none'}`
        );
    });

    test('shared values are literals only in shared/constants.js', () => {
        // Deliberately specific strings — a generic word like "pipeline" would
        // match prose. src/entry/content.js is exempt: content scripts cannot
        // be ES modules under MV3, so it cannot import constants at all.
        const guarded = [
            'embedImagesEnabled', 'uiLanguage', 'ruleAlloc',
            'pipelineWatchdog',
            'single_sheet_only', 'image_not_bitmap', 'image_embed_failed',
            'style_fill_skipped_size', 'image_budget_exceeded', 'tabnav_fallback',
        ];
        const exempt = new Set(['src/shared/constants.js', 'src/entry/content.js']);

        for (const file of ALL_SRC) {
            if (exempt.has(file)) continue;
            const src = stripComments(read(file));
            for (const value of guarded) {
                assert.ok(
                    !new RegExp(`['"\`]${value}['"\`]`).test(src),
                    `${file} hardcodes "${value}" — import it from src/shared/constants.js`
                );
            }
        }
    });
});

// ─── Entry points stay thin ─────────────────────────────────────────────────

describe('entry points are wiring only', () => {

    /** Line count matching `wc -l` — a trailing newline is not a line. */
    const lines = (rel) => read(rel).trimEnd().split('\n').length;

    test('background.js is under 120 lines', () => {
        assert.ok(lines('src/entry/background.js') < 120,
            `background.js is ${lines('src/entry/background.js')} lines`);
    });

    test('content.js is under 100 lines', () => {
        assert.ok(lines('src/entry/content.js') < 100,
            `content.js is ${lines('src/entry/content.js')} lines`);
    });

    test('popup.js is a bootstrap, not a controller', () => {
        const src = code(read('src/entry/popup.js'));
        assert.ok(!/getElementById|querySelector/.test(src),
            'popup.js touches the DOM — that belongs in src/ui/popup-view.js');
    });

    test('popup-view.js renders and decides nothing', () => {
        assert.ok(!/\bchrome\s*\./.test(code(read('src/ui/popup-view.js'))),
            'popup-view.js calls chrome.* — that belongs in the controller');
    });

    test('popup-controller.js never touches the DOM directly', () => {
        assert.ok(!/getElementById|querySelector/.test(code(read('src/ui/popup-controller.js'))),
            'popup-controller.js queries the DOM — go through src/ui/popup-view.js');
    });
});
