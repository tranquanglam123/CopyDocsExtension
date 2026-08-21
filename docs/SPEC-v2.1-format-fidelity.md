# CopyDocExt v2.1 — Format Fidelity

**Status:** Draft, awaiting approval
**Date:** 2026-08-22
**Implementer:** Sonnet
**Baseline:** v2.0.0 (`feat/v2-fetch-extraction`)
**Depends on:** `docs/SPEC-v2-dynamic-extraction.md`

---

## 0. Goal

Extracted output must look like the source document: table cell shading and
borders, column widths, fonts, colours, alignment, and the document's images
and drawings. The primary target is **paste into Google Docs** (the rich
clipboard `text/html` path), because that route runs Google's own HTML
importer and has a far higher ceiling than the hand-rolled DOCX writer.

Out of scope for this spec: watermark removal (dropped by the user), editable
equations, and the DOCX writer upgrade (§7, deferred).

---

## 1. Evidence

Measured against the user's real restricted Doc (`/mobilebasic`, 784 196 bytes):

| Probe | Result |
|-------|--------|
| `<style>` blocks | 3, totalling 13 311 chars, containing `font-weight` and `background-color` |
| Inline `style="` attributes | 3 434 |
| `<table>` elements | 8 |
| `<img>` elements | 6 — one `docs.google.com/drawings/d/…`, five `docs.google.com/docs-images-rt/…` |
| Google export endpoints | `feeds/Export`, `export?format=docx`, `export?format=zip` → **all 403** |
| `/edit` | 200, contains `DOCS_modelChunk` |

A representative table cell from the source:

```html
<td style="background-color:#c00000;border-top-width:1pt;border-top-style:solid;
           border-top-color:#ee822f;border-right-width:1pt;…;width:30.6pt;
           padding:0pt 5.4pt 0pt 5.4pt;vertical-align:top">
  <p style="text-align:center;font-size:10pt;font-family:&quot;Calibri&quot;;line-height:1.5">
    <span style="font-weight:700;font-family:&quot;Times New Roman&quot;;font-size:10pt;color:#000000">No</span>
  </p>
</td>
```

**The source is not lossy. The parser is.**

---

## 2. Root cause

`offscreen/parser.js:456-461`:

```js
el.removeAttribute('style'); // drop inline style; only re-add what we explicitly kept below

const kept = [];
if (decision.textAlign) kept.push(`text-align:${decision.textAlign}`);
if (decision.marginLeft) kept.push(`margin-left:${decision.marginLeft}`);
if (kept.length > 0) el.setAttribute('style', kept.join(';'));
```

Every element's style attribute is deleted and exactly two properties are
restored. `background-color:#c00000`, every border longhand, `font-family`,
`font-size`, `color` and `width` are destroyed on all 3 434 styled elements.

Three further defects found while red-teaming, all of which would survive a
naive "widen the whitelist" fix:

| ID | Location | Defect |
|----|----------|--------|
| F1 | `offscreen/parser.js:443-448` | A bold `<span>` is replaced by a fresh `<b>` and the span's **remaining styles are discarded** — a bold red 14pt Times span becomes a bare `<b>`. |
| F2 | `offscreen/parser.js` `ALLOWED_TAGS` | `COLGROUP`/`COL` are absent, so column-width definitions are unwrapped and lost. |
| F3 | (design) | The old code asked for the `border` **shorthand**, but the source only sets longhands (`border-top-width`, …), so `getPropertyValue('border')` returned `""` and every table border was dropped. Any whitelist keyed on shorthand names repeats this. |

---

## 3. Design — style fidelity

### 3.1 Blocklist, not whitelist

Keep the element's authored `style` attribute and remove only what breaks a
paste. A whitelist re-loses whatever Google adds next; a blocklist survives it.

```js
const STYLE_DENY = new Set([
  'position', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
  'z-index', 'transform', 'visibility', 'display', 'cursor',
  'user-select', '-webkit-user-select', 'pointer-events',
  'max-width', 'min-width', 'max-height', 'min-height',
]);
```

`display` is denied because mobilebasic sets `display:inline-block` on wrappers
that reflow badly once the surrounding chrome is gone. `max-width` is denied
because `.doc-content` carries a `770px` cap meant for the mobile viewport.

### 3.2 Authored vs. computed — the rule that keeps tables correct

Styling arrives two ways: inline attributes (3 434 of them) and the 13 KB of
class-based CSS. Class-derived styling must be resolved through
`getComputedStyle` in the sandboxed iframe. But computed values are **layout
dependent**, and the iframe is not the user's page: `getComputedStyle(td).width`
returns the used width under the iframe's own box, not the authored `30.6pt`.
Taking computed widths would silently rescale every table.

Therefore:

| Property group | Source of truth |
|----------------|-----------------|
| **Layout / geometry** — `width`, `height`, `margin*`, `padding*`, `text-indent` | **Authored only** (`el.style.getPropertyValue(...)`). Never computed. |
| **Appearance / inherited** — `color`, `background-color`, `font-family`, `font-size`, `font-weight`, `font-style`, `text-decoration*`, `text-align`, `vertical-align`, `line-height`, all `border-*` longhands, `list-style-type` | Authored if present; otherwise **computed, diffed against the parent** (emit only when it differs from the parent's computed value, so inherited values are not restated on every node) |

Set the iframe to a fixed `1000px` width before measuring, so any computed
geometry that does leak through is at least sane.

### 3.3 Property list for the computed fill

Explicit longhands — never shorthands (F3):

```
color, background-color,
font-family, font-size, font-weight, font-style, font-variant,
text-decoration-line, text-decoration-color, text-align, text-transform,
vertical-align, line-height, letter-spacing, white-space,
border-top-width, border-top-style, border-top-color,
border-right-width, border-right-style, border-right-color,
border-bottom-width, border-bottom-style, border-bottom-color,
border-left-width, border-left-style, border-left-color,
list-style-type
```

Skip a computed value when it equals the parent's, or when it is a CSS default
that carries no meaning (`rgba(0, 0, 0, 0)` background, `none` decoration,
`normal` weight/style, `0px` border width).

### 3.4 F1 — carry style across the `<span>` → `<b>` conversion

When a formatted span becomes `<b>`/`<i>`/`<u>`, copy the merged style onto the
new element before moving the children. Nothing that was on the span may be
lost. If the span carries more than one of bold/italic/underline, nest the tags
rather than picking one.

### 3.5 F2 — allowed tags

Add `COLGROUP`, `COL`, `TBODY`, `THEAD`, `TFOOT` to `ALLOWED_TAGS`, and keep the
`span` and `width` attributes on `col`/`colgroup`, plus `colspan`/`rowspan` on
`td`/`th` (verify these survive the attribute stripping — the current code
removes `class`/`id`/`role`/`dir` only, but confirm with a test).

### 3.6 Size budget

Inlining styles on ~3 400 elements grows `bodyHtml`. Measure it; if the result
exceeds **4 MB**, drop the computed-fill pass (keep authored styles only) and
add `meta.warnings: ['style_fill_skipped_size']`. Never silently truncate.

---

## 4. Design — image layer (shared by both outputs)

The six images live on `docs.google.com` and need the user's cookies. A bare
`<img src="https://docs.google.com/…">` in the clipboard will not survive a
paste into a different context, and Google's server-side importer cannot fetch
a restricted document's assets on the user's behalf.

### 4.1 `lib/image-embedder.js` (new)

`embedImages(bodyHtml, { tabId, budgetBytes })` → `{ bodyHtml, stats }`.

1. Collect every `<img src>` whose host is `docs.google.com`.
2. Fetch each through the existing transport tiers:
   - **T1** service-worker `fetch(src, {credentials:'include'})` → `arrayBuffer`.
   - **T2** fallback: `chrome.scripting.executeScript` in the doc's tab, fetch
     same-origin, convert to base64 **inside the page** and return the string
     (`executeScript` cannot return a `Blob`).
3. **Guard:** accept only when the response `content-type` starts with `image/`.
   The `docs.google.com/drawings/d/…` URL is a drawing endpoint, and it is not
   yet established that it returns a bitmap rather than an HTML viewer. If it is
   not an image, leave the original `src` untouched and record a warning.
4. Rewrite `src` to `data:<mime>;base64,<…>`.
5. Preserve the element's `width`/`height` attributes and inline sizing — the
   DOCX writer will need them later (§7).

### 4.2 Limits

- Per-image cap **4 MB**, total budget **12 MB** decoded; over budget → keep the
  original URL, warn.
- Max **4** concurrent fetches, **8 s** timeout each.
- Every failure is non-fatal: original `src` stays, and a warning is added.
  Losing an image must never lose the document.

### 4.3 Warnings surfaced to the popup

`image_embed_failed:<n>`, `image_not_bitmap:<n>`, `image_budget_exceeded`,
`style_fill_skipped_size`. All render through the existing warnings banner.

### 4.4 Toggle

A popup checkbox, **Embed images** (default **on**), persisted in
`chrome.storage.local`. It exists because whether Google Docs accepts `data:`
URIs on paste is **unverified** (§8) — the toggle is the escape hatch if it
turns out not to.

---

## 5. Clipboard path

`popup/popup.js` already writes rich HTML. Confirm it uses
`navigator.clipboard.write` with a `ClipboardItem` carrying **both**
`text/html` and `text/plain`; if it does not, make it so. The `text/html`
flavour must be the full document produced by the parser, images already
embedded.

---

## 6. File plan

| File | Action |
|------|--------|
| `offscreen/parser.js` | style engine: blocklist, authored-vs-computed rule, F1, F2, size budget |
| `lib/style-fill.js` | NEW — pure helpers: deny-list filter, parent-diff decision, default-value detection. Must be unit-testable without a DOM (take plain objects) |
| `lib/image-embedder.js` | NEW — collect, fetch, guard, rewrite |
| `lib/transport.js` | add a binary fetch helper reusing the existing T1/T2 ordering |
| `background/service-worker.js` | call `embedImages` after the offscreen parse; merge stats into `meta` |
| `popup/popup.js`, `.html`, `.css` | Embed-images toggle, new warning strings |
| `test/style-fill.test.js` | NEW |
| `test/image-embedder.test.js` | NEW (pure parts: URL collection, budget arithmetic, content-type guard) |
| `test/fixtures/mobilebasic-table.html` | NEW — a fixture built from the real cell markup in §1 |
| `lib/docx-generator.js` | **UNCHANGED** in this spec (§7) |

---

## 7. Deferred — DOCX writer (v2.2)

`lib/docx-generator.js` ignores `<img>` entirely, has no cell shading, no real
border output, no column widths, no list numbering, and no per-run font/colour.
Until that lands, **the `.docx` output will not show the images** even though
the clipboard output will. This must be stated in the popup — a one-line note
under the `.docx` button — not left for the user to discover.

---

## 8. Unverified — must be settled by the manual checklist

1. **Does Google Docs accept `data:` URI images on paste?** If it does not, the
   embed toggle is the fallback and the images travel as URLs, which will only
   work while the user's session can reach them.
2. **Does `docs.google.com/drawings/d/…` return a bitmap?** The `content-type`
   guard (§4.1.3) makes a wrong answer harmless, but the answer decides whether
   the red title block survives at all.
3. **Which transport tier serves images** — `swFetch` or `csFetch` — in this
   user's Chrome.

Add these to `test/MANUAL-CHECKLIST.md` as Path D, with the expected result for
each and what to do when it fails.

---

## 9. Tests

`node --test`, zero dependencies, ES modules. Pure logic only — the CSS cascade
still cannot run under Node.

- `style-fill`: denied properties are removed; a layout property present inline is
  kept verbatim; a computed value equal to the parent's is dropped; `rgba(0,0,0,0)`
  / `none` / `normal` / `0px` defaults are dropped; a border **longhand** is kept
  (the F3 regression).
- `image-embedder`: only `docs.google.com` sources are collected; a
  non-`image/*` content type leaves `src` untouched and emits
  `image_not_bitmap`; the per-image and total budgets stop further embedding and
  emit `image_budget_exceeded`; a failed fetch keeps the original `src`.
- Fixture: `test/fixtures/mobilebasic-table.html` carries the §1 cell verbatim.
  Assert through the manual checklist that `background-color:#c00000`,
  `border-top-color:#ee822f`, `font-family:"Times New Roman"` and `width:30.6pt`
  all survive into `bodyHtml`.

---

## 10. Acceptance criteria

1. Extracting the user's Unit-1 document and pasting into a blank Google Doc
   reproduces: red table header shading, orange cell borders, column widths,
   fonts, text colours and alignment.
2. The `docs.google.com/drawings/…` title block appears in the pasted result, or
   a warning explains precisely why it could not.
3. `bodyHtml` contains `background-color:#c00000` and `border-top-color:#ee822f`
   for the header cells — the direct regression check on §2.
4. A bold, coloured, non-default-font span keeps **all three** attributes (F1).
5. Table column widths match the source, not the iframe's layout (§3.2).
6. Every image failure degrades to the original URL plus a warning; no
   extraction fails because of an image.
7. Output size stays under 4 MB, or the size warning fires.
8. All unit tests pass.

---

## 11. Known risks (accepted)

- Equations are already-rendered bitmaps in the source (`docs-images-rt/…`), so
  they arrive as **pictures, not editable equations**. Only Google's own
  converter (403 for this document) or `DOCS_modelChunk` could do better.
- Text drawn inside a drawing — the "Unit 1: Local community" title — is not text
  in the source and cannot be recovered as selectable text from `/mobilebasic`.
- Keeping Google's authored styles verbatim means inheriting Google's quirks
  (`orphans`, `widows`, `line-height:1.5`). That is the intent: reproduce the
  source, do not improve it.
- Embedding images multiplies clipboard size by ~1.33 (base64). The budget and
  toggle bound it, but a very image-heavy document will hit the cap and fall
  back to URLs.
