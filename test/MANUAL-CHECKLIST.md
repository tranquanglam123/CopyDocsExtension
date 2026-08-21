# Manual checklist — offscreen parser (P2)

Node has no CSS engine, so `node --test` can exercise the pure decision
logic (`src/core/style-decision.js`, `src/core/container-score.js`) but **cannot**
run a real cascade end-to-end. This checklist is the D2 regression test
(spec §11: *"feed a saved mobilebasic HTML fixture with class-based
font-weight:700 and assert `<b>` appears in bodyHtml"*) run against a real
Chrome DOM instead.

Fixture: `test/fixtures/mobilebasic-sample.html` — a `/mobilebasic`-shaped
page whose bold/italic/underline live in a `<style>` block as classes
(`.c1{font-weight:700}` etc.) on `<span>`s, exactly like real Google output,
plus Google-chrome noise (`#gb`, `.gb_xyz`, `.mobile-topbar`,
`.docs-butterbar`) and a `<script>` that must never run.

---

## Path A — parser only, no service-worker wiring required

This works today, independent of whatever the background-service-worker /
manifest wiring agent has landed, because it talks to `src/entry/offscreen.js`
directly instead of going through `chrome.offscreen.createDocument`.

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `CopyDocExt` project folder. Note the generated extension ID.
2. On the CopyDocExt card, click **Details** → turn on **Allow access to
   file URLs** (needed so the console can `fetch()` the local fixture file).
3. Open a new tab at:
   `chrome-extension://<EXTENSION_ID>/src/entry/offscreen.html`
4. Open DevTools (F12) on that tab → Console tab.
5. Run (adjust the file path to wherever you checked this repo out):

   ```js
   const html = await (await fetch(
     'file:///C:/PersonalProjects/CopyDocExt/test/fixtures/mobilebasic-sample.html'
   )).text();

   const response = await chrome.runtime.sendMessage({ type: 'parse', html, docType: 'docs' });
   console.log('ok:', response.ok);
   console.log('title:', response.data.title);
   console.log('charCount:', response.data.charCount);
   console.log('warnings:', response.data.meta.warnings);
   console.log(response.data.bodyHtml);
   ```

6. **Expected results** (this is the pass/fail bar):

   | Check | Expected |
   |---|---|
   | `response.ok` | `true` |
   | `response.data.title` | `"Quarterly Planning Notes"` — **not** `"SANDBOX ESCAPED"`. If it says SANDBOX ESCAPED, the fixture's `<script>` executed inside the iframe and the sandbox is broken (`allow-scripts` must NOT be on the iframe). |
   | `bodyHtml` contains `<b>bold text</b>` (or `<b>` wrapping equivalent text) | **This is the D2 fix.** Under the pre-fix `content-script.js` logic (`node.style` only), this is absent. |
   | `bodyHtml` contains `<i>italic text</i>` | present |
   | `bodyHtml` contains `<u>underlined text</u>` | present |
   | The "bold and italic at once" span | wrapped in at least `<b>` (priority order: bold beats italic — see `StyleDecision.styleToTag`) |
   | `bodyHtml` contains an `<h1>` and two `<h2>` | present, from the fixture's headings |
   | `bodyHtml` contains a `<ul>` with 3 `<li>` | present |
   | `bodyHtml` contains a `<table>` with a header row (`Quarter`/`Spend`) and two data rows | present |
   | `bodyHtml` does **not** contain `Sign out`, `gb_`, `mobile-topbar`, or `docs-butterbar` text | noise stripped |
   | `bodyHtml` does **not** contain any `class=` or `id=` attribute | stripped after style resolution |
   | `bodyHtml` does **not** contain `<script`, `onload=`, `onerror=`, or `javascript:` | sanitisation (`src/core/html-sanitize.js`) |

7. Paste the returned `response.data.html` (the full wrapped document, not
   `bodyHtml`) into a scratch `.html` file and open it in a browser, or feed
   `response.data.bodyHtml` through `DocxGenerator.generate(bodyHtml, response.data.title)`
   (e.g. from the popup's console once wired) and open the resulting
   `.docx` in Word/LibreOffice — confirm bold/italic/underline actually
   render, closing the loop on acceptance criterion #2 in the spec
   ("Bold, italic, headings, lists and tables survive into the DOCX").

---

## Path B — full pipeline (wiring has landed)

`OffscreenManager` in `src/entry/background.js` now creates the offscreen
document and the `"offscreen"` permission is in `manifest.json`. The content
script sends `{ action:'contentReady', data:{ rawHtml, title, url, docType } }`
and the service worker routes `rawHtml` through the offscreen parser, falling
back to the in-page `DOMScanner` (via `{ action:'extract' }`) if that throws.

1. Reload the unpacked extension.
2. Open a real restricted Google Doc containing bold, italic, underlined
   text, a heading, a list, and a table.
3. Run the extension's extraction end-to-end (popup → Extract).
4. Inspect `chrome.storage.session.lastExtraction.bodyHtml` (or the popup's
   preview, once built) for the same `<b>`/`<i>`/`<u>` survival checks as
   Path A.
5. Download as `.docx` and open in Word/LibreOffice — same visual check as
   Path A step 7, but against a real document instead of the fixture.
6. Confirm `lastExtraction.meta.warnings` does **not** contain
   `"legacy_parser_fallback"`. If it does, the offscreen parse threw and the
   old in-page scanner produced the result — check the service worker console.

---

## Path C — P1 robustness (Chrome-only, none of it is unit-testable)

**C1 — watchdog restores a blocked tab (D3).** Start an extraction on a Doc,
then kill the service worker mid-flight (`chrome://serviceworker-internals`, or
the Stop button on `chrome://extensions`). Within ~60 s of the next wake, the
tab's scripts must be restored and `chrome://extensions` must show no orphaned
session rule. Verify with
`chrome.declarativeNetRequest.getSessionRules(console.log)` — nothing in the
9000-9999 band should survive.

**C2 — startup sweep.** Start an extraction, then restart Chrome while it is in
flight. After restart, the session-rule band must be empty and
`chrome.storage.session` must hold no `pipeline` or `ruleAlloc`.

**C3 — rule id allocation (D4).** Run extractions in two tabs whose ids differ
by exactly 1000 (open and close tabs until the ids line up). Both must succeed;
under the old `tabId % 1000` scheme they collided.

**C4 — Sheets via swFetch (D1).** Open a restricted Google Sheet and extract.
The user's tab must **not** navigate, and the result must carry
`meta.warnings: ['single_sheet_only']` shown as a yellow banner. Confirm the
data matches sheet `gid=0`.

**C5 — Sheets false-positive guard.** Extract a spreadsheet that legitimately
contains the words "Sign in" in a cell (an attendance/sign-in sheet). It must
extract normally — the access-wall regex only applies to non-CSV responses.

**C6 — Sheets access wall.** Extract a spreadsheet you do not have access to.
It must fail with a clear access/sign-in message, never with parsed garbage.

**C7 — Slides.** Open a Google Slides deck. The popup must say Slides is not
supported yet and must not start a pipeline.

---

## Path D — image embedding (spec §4, v2.1)

`src/extraction/image-embedder.js` and the binary-fetch tiers in `src/extraction/http-transport.js`
(`swFetchBinary`/`csFetchBinary`/`fetchBinary`) have full pure-logic coverage
under `node --test` (`test/image-embedder.test.js`: URL collection, the
content-type guard, both budgets, failed fetches — all against an injected
`fetchFn`, never the real network). What `node --test` categorically **cannot**
answer is spec §8's three unverified questions, because they depend on a real
Chrome, a real restricted Google Doc, and Google's own paste importer. Run
Path D against **the user's actual restricted Unit-1 document** (the one with
the six images: one `docs.google.com/drawings/d/…` title block, five
`docs.google.com/docs-images-rt/…` equations/pictures) — a synthetic fixture
can't answer any of these three.

Before starting: `chrome://extensions` → reload the unpacked CopyDocExt →
open the document's tab → open the popup → confirm **Embed images** is
checked (it's ON by default) → open two DevTools consoles side by side: one
on the popup (right-click the popup → Inspect), one on the service worker
(the "service worker" link on the CopyDocExt card in `chrome://extensions`).

### D1 — Does Google Docs accept `data:` URI images on paste? (spec §8 Q1)

This is the question the whole "Embed images" toggle exists to hedge against.

1. Click **Extract**. Wait for completion.
2. In the popup's DevTools console, confirm the images actually got embedded
   before testing the paste side, so a paste failure can't be confused with
   an embedding failure:
   ```js
   const r = await chrome.runtime.sendMessage({ action: 'getExtractionStatus' });
   console.log(r.data.meta.imageStats);
   console.log(r.data.bodyHtml.includes('data:image'));
   ```
   Expect `imageStats.embedded` > 0 and the second line `true`. If not, stop
   here — this is an embedding bug (check D2/D3 below), not a paste bug, and
   D1 can't be meaningfully tested yet.
3. Click **Copy**.
4. Open a blank Google Doc (or click **New Doc**, which does both steps).
5. Press Ctrl+V to paste.
6. **Expected:** all embedded images appear inline in the pasted result, at
   roughly their source size and position.
7. **If it fails** (broken image icons, images silently missing, or Google
   Docs shows an error/strips the paste down to plain text):
   - This means step D1's premise is false — Google Docs does not accept
     `data:` URI images on paste (or not reliably). Turn **Embed images**
     OFF in the popup, re-extract, re-copy, re-paste, and confirm the
     un-embedded `https://docs.google.com/…` image URLs paste in as plain
     links instead (broken images, since the paste target has no session
     cookie for them — but at least the paste itself doesn't fail).
   - Report which of the two outcomes actually happened. If `data:` URIs are
     confirmed not to work, the toggle's **default** should flip from ON to
     OFF in a follow-up change — that decision needs this result, not a guess.

### D2 — Does `docs.google.com/drawings/d/…` return a bitmap? (spec §8 Q2)

The content-type guard (§4.1.3) makes a wrong answer harmless (the original
link is kept, `image_not_bitmap` is warned), but the answer decides whether
the red title block can ever survive at all, embedded or not.

1. After a completed extraction (Embed images ON), in the popup's console:
   ```js
   const r = await chrome.runtime.sendMessage({ action: 'getExtractionStatus' });
   console.log(r.data.meta.imageStats);
   console.log(r.data.meta.warnings);
   ```
2. **Expected if it IS a bitmap:** `imageStats.notBitmap === 0` and
   `imageStats.embedded` includes the drawing (the drawings URL no longer
   appears anywhere in `r.data.bodyHtml` — it was rewritten to a `data:` URI).
3. **Expected if it is NOT a bitmap:** `imageStats.notBitmap >= 1` and
   `warnings` contains `"image_not_bitmap:1"` (or higher, if other images also
   failed the guard). Confirm directly, independent of the extension, by
   running this in the *document's own tab* console (so it carries the
   session cookie):
   ```js
   const res = await fetch('<the docs.google.com/drawings/d/… URL from view-source>', { credentials: 'include' });
   console.log(res.status, res.headers.get('content-type'));
   ```
   A `content-type` starting with `text/html` confirms the drawings endpoint
   is a viewer page, not an image — matching the guard's decision.
4. **If it's not a bitmap:** there is no code fix available in this pass
   (spec §11 accepts this as a known risk — text drawn inside a drawing isn't
   recoverable from `/mobilebasic` at all). Confirm instead that the failure
   is *visible*, not silent: the popup's warnings banner must show a
   human-readable message for `image_not_bitmap:<n>`, not just swallow it.

### D3 — Which transport tier serves images: `swFetch` or `csFetch`? (spec §8 Q3)

`src/extraction/http-transport.js` `fetchBinary` logs every attempt — this is answerable
directly from the service worker console, no experimentation needed.

1. Clear the service worker console.
2. Extract the document (Embed images ON).
3. Read the console output. Every image produces one of:
   - `[Transport] swFetchBinary succeeded for <url> (image/…).` — T1 served it.
   - `[Transport] swFetchBinary failed (<reason>) for <url> — trying csFetchBinary.`
     followed by `[Transport] csFetchBinary succeeded for <url> (image/…).` — T2
     served it (third-party cookies were likely blocked for T1).
4. **Expected:** six such outcomes (one per image), all ending in a success
   line from one tier or the other.
5. **If some end in neither** (both `swFetchBinary failed` and
   `csFetchBinary failed` for the same URL): that image degrades to
   `image_embed_failed` — confirm the warning banner shows it, and confirm
   the document/paste still succeeds otherwise (spec §4.2 — losing one image
   must never lose the document). Check the failure reason logged
   (`HTTP <status>` vs. a wall reason like `cookies_help_redirect`) to tell a
   genuine network failure apart from a session/cookie problem.
6. Record which tier won for this user's Chrome profile — if it's always T2
   `csFetchBinary`, that's a signal third-party cookies are blocked for this
   user (consistent with why T2 exists for the document-HTML fetch too, see
   `src/extraction/http-transport.js`'s file header) and is useful context for future work,
   not just for this checklist.

---

## What is NOT covered by this checklist

- The structural container-detection **fallback** (`src/core/container-score.js`
  scoring path) only activates when none of `OffscreenParser.CONTAINER_SELECTORS`
  match — the bundled fixture's `div.doc-content#contents` hits the fast
  path. To exercise the fallback manually, strip the fixture's
  `class="doc-content" id="contents"` attributes and re-run Path A; the
  parser should still find the content via scoring and
  `response.data.meta.warnings` should include `"container_fallback_used"`.
- Multi-tab Docs, multi-sheet Sheets, Slides, the quality gate, and the
  ranker are **P3 scope** (`src/extraction/strategy-registry.js`, `src/extraction/quality-gate.js`,
  `src/extraction/ranker.js` — not yet built) and are not exercised here. The transport
  tiers (`src/extraction/http-transport.js`) ARE built as of v2.1 (both the document-HTML
  tiers exercised by Path A/B and the image-binary tiers exercised by Path D)
  — only `detectWall` has automated coverage (`test/transport.test.js`); the
  fetch tiers themselves are Chrome-API-dependent and are exercised by Path D
  above and by Path A/B for the document HTML.
