/**
 * Layering written only in a document rots. These tests are the enforcement.
 * They read source as text: most modules reference `chrome` and cannot be
 * imported under Node.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Every .js file under a directory, as repo-relative POSIX paths. */
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
 * Source with comments and string literals blanked out. Without this,
 * `zip.addFile('word/document.xml')` reads as a `document.` usage.
 */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Comments removed, strings kept — for rules that look for string literals. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const importsOf = (rel) =>
    [...read(rel).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

const LIB = jsFiles(join(SRC, 'lib'));
const EXTRACT = jsFiles(join(SRC, 'background', 'extract'));
const BRIDGE = jsFiles(join(SRC, 'bridge'));
const ALL_SRC = jsFiles(SRC);
const REALMS = /(popup|background|offscreen|content)\//;

// ─── Layer purity ───────────────────────────────────────────────────────────

describe('layer purity', () => {

    test('lib/ never touches chrome.* — it is the layer node --test can exercise', () => {
        for (const file of LIB) {
            assert.ok(
                !/\bchrome\s*\./.test(code(read(file))),
                `${file} calls chrome.* — move that behind src/bridge/`
            );
        }
    });

    test('lib/ never touches DOM globals', () => {
        // `Blob` is excluded: a standard global in browser and Node 18+, and
        // the DOCX writer legitimately produces one.
        for (const file of LIB) {
            const src = code(read(file));
            assert.ok(!/\bDOMParser\b/.test(src), `${file} uses DOMParser`);
            assert.ok(!/\bwindow\s*\./.test(src), `${file} uses window.`);
            assert.ok(
                !/\bdocument\s*\.\s*(getElementById|querySelector|createElement|body|head|title)\b/.test(src),
                `${file} touches the live document`
            );
        }
    });

    test('background/extract/ goes through bridge/ instead of calling chrome.* directly', () => {
        for (const file of EXTRACT) {
            assert.ok(
                !/\bchrome\s*\./.test(code(read(file))),
                `${file} calls chrome.* — use a src/bridge/ wrapper`
            );
        }
    });
});

// ─── Dependency direction ───────────────────────────────────────────────────

describe('dependency direction', () => {

    test('lib/ imports nothing outside lib/', () => {
        for (const file of LIB) {
            for (const spec of importsOf(file)) {
                assert.ok(
                    !REALMS.test(spec) && !spec.includes('bridge/'),
                    `${file} imports ${spec} — lib/ sits below every layer`
                );
            }
        }
    });

    test('bridge/ never depends on a realm', () => {
        for (const file of BRIDGE) {
            for (const spec of importsOf(file)) {
                assert.ok(!REALMS.test(spec), `${file} imports ${spec} — bridge/ sits below the realms`);
            }
        }
    });

    test('no realm imports another realm', () => {
        for (const file of ALL_SRC) {
            const own = file.split('/')[1];
            if (!/^(popup|background|offscreen|content)$/.test(own)) continue;
            for (const spec of importsOf(file)) {
                for (const other of ['popup', 'background', 'offscreen', 'content']) {
                    if (other === own) continue;
                    assert.ok(
                        !spec.includes(`${other}/`) || spec.includes(`bridge/chrome/${other}`),
                        `${file} imports ${spec} — realms only meet through messages`
                    );
                }
            }
        }
    });

    test('nothing imports an entry point', () => {
        for (const file of ALL_SRC) {
            for (const spec of importsOf(file)) {
                assert.ok(!/\/main\.js$/.test(spec), `${file} imports ${spec} — entries are leaves`);
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
            ['src/lib/html.js'],
            `expected one definition, found: ${definitions.join(', ') || 'none'}`
        );
    });

    test('shared values are literals only in lib/const.js', () => {
        // Specific strings on purpose — a generic word like "pipeline" would
        // match prose. content/main.js is exempt: content scripts cannot be
        // ES modules under MV3, so it cannot import anything.
        const guarded = [
            'embedImagesEnabled', 'uiLanguage', 'ruleAlloc',
            'pipelineWatchdog',
            'single_sheet_only', 'image_not_bitmap', 'image_embed_failed',
            'style_fill_skipped_size', 'image_budget_exceeded', 'tabnav_fallback',
        ];
        const exempt = new Set(['src/lib/const.js', 'src/content/main.js']);

        for (const file of ALL_SRC) {
            if (exempt.has(file)) continue;
            const src = stripComments(read(file));
            for (const value of guarded) {
                assert.ok(
                    !new RegExp(`['"\`]${value}['"\`]`).test(src),
                    `${file} hardcodes "${value}" — import it from src/lib/const.js`
                );
            }
        }
    });
});

// ─── Entry points stay thin ─────────────────────────────────────────────────

describe('entry points are wiring only', () => {

    /** Line count matching `wc -l` — a trailing newline is not a line. */
    const lines = (rel) => read(rel).trimEnd().split('\n').length;

    test('background/main.js is under 120 lines', () => {
        assert.ok(lines('src/background/main.js') < 120,
            `background/main.js is ${lines('src/background/main.js')} lines`);
    });

    test('content/main.js is under 100 lines', () => {
        assert.ok(lines('src/content/main.js') < 100,
            `content/main.js is ${lines('src/content/main.js')} lines`);
    });

    test('popup/main.js is a bootstrap, not a controller', () => {
        assert.ok(!/getElementById|querySelector/.test(code(read('src/popup/main.js'))),
            'popup/main.js touches the DOM — that belongs in src/popup/view.js');
    });

    test('popup/view.js renders and decides nothing', () => {
        assert.ok(!/\bchrome\s*\./.test(code(read('src/popup/view.js'))),
            'popup/view.js calls chrome.* — that belongs in the controller');
    });

    test('popup/controller.js never touches the DOM directly', () => {
        assert.ok(!/getElementById|querySelector/.test(code(read('src/popup/controller.js'))),
            'popup/controller.js queries the DOM — go through src/popup/view.js');
    });
});
