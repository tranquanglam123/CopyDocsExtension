/**
 * Layering written only in a document rots. These tests are the enforcement,
 * and AGENTS.md is their prose copy.
 *
 * They read source as text: most modules reference `chrome` and cannot be
 * imported under Node.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

const REALMS = ['popup', 'background', 'offscreen', 'content'];

/** MV3 content scripts are not ES modules, so this one file cannot import. */
const CONTENT_ENTRY = 'src/content/main.js';

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

/** Line count matching `wc -l` — a trailing newline is not a line. */
const lines = (rel) => read(rel).trimEnd().split('\n').length;

const ALL_SRC = jsFiles(SRC);
const LIB = jsFiles(join(SRC, 'lib'));
const BRIDGE = jsFiles(join(SRC, 'bridge'));

/** The realm folder a file belongs to, or null for bridge/ and lib/. */
const realmOf = (file) => {
    const top = file.split('/')[1];
    return REALMS.includes(top) ? top : null;
};

// ─── 1. chrome.* lives under bridge/ alone ──────────────────────────────────

describe('chrome access', () => {

    test('chrome.* appears only under src/bridge/', () => {
        for (const file of ALL_SRC) {
            if (file.startsWith('src/bridge/') || file === CONTENT_ENTRY) continue;
            assert.ok(
                !/\bchrome\s*\./.test(code(read(file))),
                `${file} calls chrome.* — go through src/bridge/`
            );
        }
    });

    test('the content script is the only exemption, and it stays a plain script', () => {
        assert.ok(existsSync(join(ROOT, CONTENT_ENTRY)));
        assert.ok(
            !/^\s*import\s/m.test(code(read(CONTENT_ENTRY))),
            'content/main.js imports — MV3 content scripts are not ES modules'
        );
    });
});

// ─── 2. DOM access follows the realm ────────────────────────────────────────

describe('DOM access', () => {

    test('background/, bridge/ and lib/ never touch the DOM', () => {
        // `Blob` and `FileReader` are excluded: standard globals in a worker.
        const domless = ALL_SRC.filter((f) =>
            f.startsWith('src/background/') || f.startsWith('src/bridge/') || f.startsWith('src/lib/')
        );
        for (const file of domless) {
            const src = code(read(file));
            assert.ok(!/\bDOMParser\b/.test(src), `${file} uses DOMParser`);
            assert.ok(!/\bwindow\s*\./.test(src), `${file} uses window.`);
            assert.ok(
                !/\bdocument\s*\.\s*(getElementById|querySelector|createElement|body|head|title)\b/.test(src),
                `${file} touches the live document`
            );
        }
    });
});

// ─── 3-7. Dependency direction ──────────────────────────────────────────────

describe('dependency direction', () => {

    test('no realm imports another realm — they only meet through messages', () => {
        for (const file of ALL_SRC) {
            const own = realmOf(file);
            if (!own) continue;
            for (const spec of importsOf(file)) {
                for (const other of REALMS) {
                    if (other === own) continue;
                    assert.ok(
                        !spec.includes(`${other}/`),
                        `${file} imports ${spec} — realms only meet through messages`
                    );
                }
            }
        }
    });

    test('lib/ imports nothing outside lib/ — it is the bottom of the graph', () => {
        for (const file of LIB) {
            for (const spec of importsOf(file)) {
                const reaches = REALMS.some((r) => spec.includes(`${r}/`)) || spec.includes('bridge/');
                assert.ok(!reaches, `${file} imports ${spec} — lib/ sits below every layer`);
            }
        }
    });

    test('bridge/ never imports a realm', () => {
        for (const file of BRIDGE) {
            for (const spec of importsOf(file)) {
                assert.ok(
                    !REALMS.some((r) => spec.includes(`${r}/`)),
                    `${file} imports ${spec} — bridge/ sits below the realms`
                );
            }
        }
    });

    test('nothing imports an entry point — main.js files are leaves', () => {
        for (const file of ALL_SRC) {
            for (const spec of importsOf(file)) {
                assert.ok(!/\/main\.js$/.test(spec), `${file} imports ${spec}`);
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

// ─── 8. Shared values live in one file each ─────────────────────────────────

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

    test('storage keys, warning codes and alarm names are literals only in lib/const.js', () => {
        // Specific strings on purpose — a generic word like "pipeline" would
        // match prose.
        const guarded = [
            'embedImagesEnabled', 'uiLanguage', 'ruleAlloc',
            'pipelineWatchdog',
            'single_sheet_only', 'image_not_bitmap', 'image_embed_failed',
            'style_fill_skipped_size', 'image_budget_exceeded', 'tabnav_fallback',
        ];
        const exempt = new Set(['src/lib/const.js', CONTENT_ENTRY]);

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

    test('message names are literals only in bridge/contract.js', () => {
        const guarded = [
            'checkTab', 'startExtraction', 'getExtractionStatus',
            'openNewDoc', 'contentReady',
        ];
        const exempt = new Set(['src/bridge/contract.js', CONTENT_ENTRY]);

        for (const file of ALL_SRC) {
            if (exempt.has(file)) continue;
            const src = stripComments(read(file));
            for (const value of guarded) {
                assert.ok(
                    !new RegExp(`['"\`]${value}['"\`]`).test(src),
                    `${file} hardcodes the message "${value}" — import MSG from src/bridge/contract.js`
                );
            }
        }
    });
});

// ─── 9-10. Entry points and the popup split ─────────────────────────────────

describe('entry points', () => {

    test('every realm has exactly one main.js, and the manifest points at those', () => {
        const manifest = read('manifest.json');
        for (const realm of REALMS) {
            const entries = jsFiles(join(SRC, realm)).filter((f) => /\/main\.js$/.test(f));
            assert.deepEqual(entries, [`src/${realm}/main.js`], `${realm}/ needs one main.js`);
        }
        assert.match(manifest, /"src\/background\/main\.js"/);
        assert.match(manifest, /"src\/content\/main\.js"/);
        assert.match(manifest, /"src\/popup\/popup\.html"/);
        assert.match(read('src/popup/popup.html'), /src="main\.js"/);
        assert.match(read('src/offscreen/offscreen.html'), /src="main\.js"/);
    });

    test('background/main.js is under 120 lines', () => {
        assert.ok(lines('src/background/main.js') < 120,
            `background/main.js is ${lines('src/background/main.js')} lines`);
    });

    test('content/main.js is under 100 lines', () => {
        assert.ok(lines('src/content/main.js') < 100,
            `content/main.js is ${lines('src/content/main.js')} lines`);
    });

    test('offscreen/main.js is under 120 lines', () => {
        assert.ok(lines('src/offscreen/main.js') < 120,
            `offscreen/main.js is ${lines('src/offscreen/main.js')} lines`);
    });

    test('popup/main.js is a bootstrap, not a controller', () => {
        assert.ok(!/getElementById|querySelector/.test(code(read('src/popup/main.js'))),
            'popup/main.js touches the DOM — that belongs in src/popup/view.js');
    });
});

describe('the popup split', () => {

    test('view.js renders and decides nothing', () => {
        assert.ok(!/\bchrome\s*\./.test(code(read('src/popup/view.js'))),
            'popup/view.js calls chrome.* — that belongs in the controller');
        for (const spec of importsOf('src/popup/view.js')) {
            assert.ok(!spec.includes('bridge/'),
                `popup/view.js imports ${spec} — messaging belongs in the controller`);
        }
    });

    test('controller.js never touches the DOM directly', () => {
        assert.ok(!/getElementById|querySelector/.test(code(read('src/popup/controller.js'))),
            'popup/controller.js queries the DOM — go through src/popup/view.js');
    });
});
