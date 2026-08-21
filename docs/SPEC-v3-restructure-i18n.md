# CopyDocExt v3 — Restructure, i18n, README

**Status:** Draft
**Date:** 2026-08-22
**Implementer:** Sonnet
**Baseline:** v2.1 on `feat/v2-fetch-extraction`

---

## 0. Goals

1. A structure a stranger can trace top-down: entry points → orchestration →
   platform → pure logic, with each file's job obvious from its path.
2. One implementation per concept. No duplicated parsers, HTML wrappers, or
   storage keys.
3. Runtime English/Vietnamese switching.
4. A short, honest README in both languages.

**Non-goals:** no behaviour change, no new extraction capability, no build step,
no dependencies, no framework. The extension works today — this must not cost
that.

---

## 1. Audit (measured, 2026-08-22)

Total 6 202 LOC of JavaScript.

| File | LOC | Problem |
|------|-----|---------|
| `background/service-worker.js` | 1213 | 6 classes. `ExtensionController` alone does message routing, downloads, four pipelines, the watchdog, tab utilities, image orchestration and HTML splicing |
| `offscreen/parser.js` | 671 | parser + DOM host + document wrapper in one file |
| `popup/popup.js` | 505 | 20 module-level DOM constants, mutable module state, view + flow + export handlers mixed |
| `lib/transport.js` | 483 | 8 exports covering HTML and binary transport plus wall detection |
| `content/content-script.js` | 407 | contains `DOMScanner`, **a second full parser** duplicating `offscreen/parser.js` |

Concrete duplication:

- `wrapAsDocument` exists **three times** — `content/content-script.js:194`,
  `offscreen/parser.js:613`, `background/service-worker.js:260` (whose comment
  admits it "deliberately mirrors" the others).
- The storage key `'embedImagesEnabled'` is hardcoded in
  `background/service-worker.js:238` and `popup/popup.js:50`.
- `lib/` is a flat bag mixing pure domain logic (`style-fill`), infrastructure
  (`transport`, `mini-zip`) and output formats (`docx-generator`).

README defects: it points at `install.bat` and `LICENSE`, **neither of which
exists**; it documents the deleted `rules/` directory; and it describes the
tab-navigation-with-JavaScript-disabled mechanism that was replaced by fetch
transports in v2.0.

---

## 2. Target structure

```
manifest.json
src/
  entry/            # thin wiring only — nothing else lives here
    background.js
    content.js
    offscreen.html
    offscreen.js
    popup.html
    popup.js
    popup.css
  extraction/       # orchestration: what happens, in what order
    targets.js
    http-transport.js
    binary-transport.js
    image-embedder.js
    pipeline-state.js
    fetch-pipeline.js
    csv-pipeline.js
    tabnav-pipeline.js
    pipeline-runner.js
  platform/         # the ONLY place chrome.* may appear
    storage.js
    tabs.js
    messaging.js
    scripting.js
    downloads.js
    offscreen-host.js
    net-rules.js
    alarms.js
  core/             # pure: no chrome.*, no DOM globals, unit-testable
    document-url.js
    wall-detector.js
    html-sanitize.js
    html-document.js
    style-decision.js
    style-fill.js
    container-score.js
    csv-to-html.js
    docx-generator.js
    mini-zip.js
  ui/               # popup logic, split from its entry
    popup-view.js
    popup-controller.js
    popup-exports.js
  shared/
    constants.js
    i18n.js
    locales/en.js
    locales/vi.js
docs/
test/
```

**Depth rule:** at most two levels below `src/`. There is no bundler, so every
import is a hand-written relative path; `../../core/html/x.js` is how those
break. Each layer stays flat.

**Dependency rule, enforced by a test (§8):**

```
entry → ui, extraction, platform, shared
extraction → platform, core, shared
platform → shared            (chrome.* allowed here and nowhere else)
core → shared                (pure; no chrome.*, no window/document)
```

`core/` may be imported by anything; `core/` imports nothing but `shared/`.

---

## 3. Migration rules

1. **Phase 1 is moves only.** Use `git mv` so history follows the file. Fix
   import paths and `manifest.json`. Change **no logic**. `node --test` must be
   green and the extension must still extract before anything else starts.
2. Never mix a move and a rewrite in the same step — when something breaks, the
   diff has to say which one did it.
3. Public behaviour is frozen: same messages, same `meta` shape, same storage
   keys (now via `shared/constants.js`), same popup flow.

---

## 4. Phases

### P1 — moves

`lib/*` → `src/core/*` and `src/extraction/*` per §7. Entries → `src/entry/*`.
Update `manifest.json` paths and every import. Tests updated to the new paths.
No logic edits.

### P2 — split the god objects

- `background/service-worker.js` (1213 LOC) becomes `src/entry/background.js`
  (wiring and listener registration only, target under 120 LOC) plus:
  `platform/net-rules.js` (was `PolicyManager`), `platform/offscreen-host.js`
  (was `OffscreenManager`), `platform/downloads.js`, `platform/tabs.js`,
  `platform/messaging.js`, `platform/alarms.js`, `platform/storage.js`,
  `extraction/pipeline-state.js`, and the four pipeline modules with
  `extraction/pipeline-runner.js` holding dispatch and the watchdog.
- `popup/popup.js` (505 LOC) becomes `src/entry/popup.js` (bootstrap) plus
  `ui/popup-view.js` (status, steps, warnings, notifications — all DOM writes),
  `ui/popup-controller.js` (flow and messaging), `ui/popup-exports.js`
  (copy / new doc / docx / txt).
- `offscreen/parser.js` (671 LOC) keeps the DOM host in `src/entry/offscreen.js`
  and moves the extraction passes into `core/` helpers it already imports.

Every extracted module keeps its existing JSDoc and comments — the reasoning in
them is why the current behaviour is correct.

### P3 — one implementation per concept

- `core/html-document.js` becomes the single `wrapAsDocument`; delete the copies
  in the service worker and the content script.
- **Delete `DOMScanner` from the content script.** `src/entry/content.js` keeps
  only readiness detection and returns raw HTML — target under 100 LOC. The
  offscreen parser becomes the single parser in the codebase.
  *Consequence, accepted deliberately:* the in-page legacy fallback disappears.
  `parseContentPayload`'s `{action:'extract'}` retry must be removed with it, and
  its failure path must return a clear error instead. A duplicate of the same
  logic would fail on the same input anyway; two parsers that drift apart cost
  more than the fallback is worth.
- Every storage key, warning code, alarm name, rule-id bound and timeout moves
  to `shared/constants.js`. No string literal for any of them anywhere else.

### P4 — i18n (§5)

### P5 — README and LICENSE (§6)

Each phase ends green and is committed separately.

---

## 5. i18n

### 5.1 Why not `chrome.i18n`

Chrome's native `_locales` mechanism resolves the locale from the browser UI
language and **cannot be switched at runtime**. The requirement is an in-popup
English/Vietnamese toggle, so native i18n cannot satisfy it. Do not add
`_locales`; one mechanism only.

### 5.2 `shared/i18n.js`

```js
await I18n.init();                 // load persisted language, else detect
I18n.t('popup.status.detected', { type: 'Google Doc' });
await I18n.setLanguage('vi');      // persists, re-renders
I18n.apply(document);              // fills [data-i18n], [data-i18n-title], [data-i18n-aria-label]
```

- Dictionaries are ES modules (`shared/locales/en.js`, `vi.js`), not JSON — no
  fetch, no `web_accessible_resources`, works identically in the popup and the
  service worker.
- Default language: `chrome.i18n.getUILanguage()` starting with `vi` → Vietnamese,
  otherwise English. A user choice persists in `chrome.storage.local` under a key
  from `shared/constants.js`.
- A missing key returns the key itself and logs a warning. Never render blank.
- `en.js` is the reference: a test asserts `vi.js` has exactly the same key set,
  so a new string cannot silently ship untranslated.

### 5.3 Error messages must become codes

The service worker currently throws English `Error` strings that the popup
displays verbatim, which cannot be translated. Introduce:

```js
class AppError extends Error {   // core/app-error.js
  constructor(code, params = {}) { … }   // e.g. new AppError('error.accessWall', { docType })
}
```

Pipelines throw `AppError`; the popup translates `code` with `params`. An error
without a code still displays its raw message — degrade, never blank.

### 5.4 Coverage

Every user-visible string: popup labels, buttons, step names, status lines,
warning messages, the `.docx` image note, error text. Warning codes
(`image_not_bitmap`, `single_sheet_only`, `style_fill_skipped_size`,
`legacy_parser_fallback`, `tabnav_fallback`, `image_budget_exceeded`,
`image_embed_failed`) become i18n keys rather than English sentences.

### 5.5 Popup control

A compact language selector in the popup footer next to the version. Switching
re-renders immediately — no reopen. It must not disturb an in-flight extraction.

---

## 6. README

- `README.md` (English) and `README.vi.md` (Vietnamese), each opening with a
  one-line link to the other. GitHub cannot render a real toggle; two files with
  cross-links is the honest equivalent.
- **No emoji, no decorative icons.**
- Short: what it does, install, usage, limits, privacy, licence. Aim for under
  80 lines each. Cut the troubleshooting table down to the three failures that
  actually happen.
- Fix the false statements: `install.bat` and the `rules/` directory do not
  exist; the mechanism is now fetch-based, not tab-navigation-with-JS-disabled;
  Slides is unsupported; `.docx` output does not include images.
- State the real limits: equations and drawings arrive as pictures; text drawn
  inside a drawing is not recoverable as text; only the first sheet of a
  spreadsheet is read.
- Add the `LICENSE` file the README has always claimed (MIT, matching the
  existing README statement), or drop the claim. Adding it is preferred.
- Update the project-structure section to the §2 layout.

---

## 7. File map

| From | To |
|------|-----|
| `lib/url-transformer.js` | `src/core/document-url.js` |
| `lib/html-sanitize.js` | `src/core/html-sanitize.js` |
| `lib/style-decision.js` | `src/core/style-decision.js` |
| `lib/style-fill.js` | `src/core/style-fill.js` |
| `lib/container-score.js` | `src/core/container-score.js` |
| `lib/csv-to-html.js` | `src/core/csv-to-html.js` |
| `lib/docx-generator.js` | `src/core/docx-generator.js` |
| `lib/mini-zip.js` | `src/core/mini-zip.js` |
| `lib/transport.js` `detectWall`/`isImageContentType` | `src/core/wall-detector.js` |
| `lib/transport.js` HTML tiers | `src/extraction/http-transport.js` |
| `lib/transport.js` binary tiers | `src/extraction/binary-transport.js` |
| `lib/image-embedder.js` | `src/extraction/image-embedder.js` |
| `lib/export-service.js` | `src/ui/popup-exports.js` (merge; it is popup-only) |
| `background/service-worker.js` | `src/entry/background.js` + platform/extraction modules |
| `content/content-script.js` | `src/entry/content.js` (gutted per P3) |
| `offscreen/parser.{html,js}` | `src/entry/offscreen.{html,js}` + core helpers |
| `popup/*` | `src/entry/popup.*` + `src/ui/*` |
| *(new)* | `src/core/html-document.js`, `src/core/app-error.js`, `src/shared/constants.js`, `src/shared/i18n.js`, `src/shared/locales/{en,vi}.js` |

---

## 8. Tests

Existing suites move with their subjects and must stay green throughout.

New `test/architecture.test.js` — the structure is only real if it is enforced:

- no file under `src/core/` contains `chrome.` or `document.` or `window.`;
- no file outside `src/platform/` and `src/entry/` contains `chrome.`;
- `wrapAsDocument` is defined exactly once in the tree;
- the literal strings for storage keys, warning codes and alarm names appear only
  in `src/shared/constants.js`;
- no import path contains `../../..`;
- `src/entry/background.js` is under 120 lines and `src/entry/content.js` under 100.

New `test/i18n.test.js`:

- `en.js` and `vi.js` have identical key sets (no untranslated string can ship);
- no value is an empty string;
- `t()` interpolates params and returns the key for a missing entry;
- every warning code in `shared/constants.js` has a matching message key.

---

## 9. Acceptance criteria

1. `node --test` green after every phase, not only at the end.
2. The extension still extracts the user's restricted Unit-1 document, still
   embeds its images, and pasting into Google Docs still reproduces the red
   header shading and orange borders — the v2.1 result must not regress.
3. `chrome.` appears in no file outside `src/platform/` and `src/entry/`.
4. `wrapAsDocument` is defined once.
5. Storage keys, warning codes and alarm names exist only in
   `src/shared/constants.js`.
6. Switching the popup language changes every visible string with no reopen, and
   the choice survives a browser restart.
7. `vi.js` and `en.js` key sets match exactly.
8. `README.md` and `README.vi.md` are under 80 lines each, contain no emoji, and
   describe only files and behaviour that actually exist.
9. `manifest.json` points at the new paths and the extension loads with no errors
   on `chrome://extensions`.

---

## 10. Risks

- **A restructure can silently break a working extension.** Mitigated by the
  moves-only first phase, per-phase green tests, and the manual smoke test in
  `test/MANUAL-CHECKLIST.md` after each phase. If a phase cannot be made green,
  stop and report rather than pressing on.
- **Deleting `DOMScanner` removes the in-page fallback.** Deliberate (§4 P3), but
  it means an offscreen-parser failure is now fatal to that extraction. The error
  must say so clearly.
- **Splitting the service worker touches the watchdog, the rule allocator and the
  startup sweep** — the machinery that stops a tab being left script-blocked.
  These have no unit tests (they need Chrome). Treat their code as
  move-don't-touch, and re-run manual checklist Path C afterwards.
- **A structure without enforcement rots.** Hence `test/architecture.test.js`
  rather than a convention documented and then ignored.
